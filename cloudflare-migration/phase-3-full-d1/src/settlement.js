import { buildKotStatements } from "./kot.js";

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function actorLabel(user) {
  return String(user?.display_name || user?.username || "Staff").trim().slice(0, 160) || "Staff";
}

export async function settleOrder(request, env, businessId, bridgeClaims, orderId) {
  if (String(env.D1_STAGING_PAYMENT_WRITES_ENABLED || "").toLowerCase() !== "true") {
    return { status: 503, error: "D1 staging payment writes are disabled until the payment pilot is enabled." };
  }
  if (!bridgeClaims || bridgeClaims.scope !== "payments.create" || Number(bridgeClaims.business_id) !== businessId) {
    return { status: 403, error: "A signed payment permission is required." };
  }

  try {
    const raw = await request.text();
    if (raw.length > 32768) throw fail(413, "Payment request is too large.");
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { throw fail(400, "Invalid payment request JSON."); }

    const order = await env.DB.prepare(`
      SELECT id, business_id, order_number, order_type, table_number, subtotal, gst, total,
        payment_method, status, customer_id, public_tracking_token, sales_channel_key
      FROM orders WHERE id = ? AND business_id = ? LIMIT 1
    `).bind(orderId, businessId).first();
    if (!order) throw fail(404, "Order not found.");
    if (String(order.status || "").toLowerCase() === "cancelled") throw fail(409, "Cancelled orders cannot be settled.");

    const prior = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS collected,
        COALESCE(json_group_array(json_object('method', method, 'amount', amount)), '[]') AS allocations
      FROM (
        SELECT payment_method AS method, SUM(amount) AS amount
        FROM payments
        WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'
        GROUP BY payment_method
      )
    `).bind(orderId, businessId).first();
    const collectedBefore = money(Number(prior?.collected || 0));
    const billTotal = Math.max(0, money(Number(order.total || 0)));
    const remaining = Math.max(0, money(billTotal - collectedBefore));
    if (remaining <= 0.009) throw fail(409, "This order has no balance remaining.");

    const isQrOrder = Boolean(order.public_tracking_token) || /^QR-/i.test(String(order.order_number || ""));
    const currentStatus = String(order.status || "").trim();
    if (isQrOrder && currentStatus.toLowerCase() !== "ready" && !(currentStatus.toLowerCase() === "completed" && remaining > 0.009)) {
      throw fail(409, "QR orders must be accepted and marked ready before checkout.");
    }

    const settingsRow = await env.DB.prepare("SELECT settings FROM app_settings WHERE business_id = ? LIMIT 1").bind(businessId).first();
    const settings = parseJson(settingsRow?.settings, {});
    const nonChargeable = body.nonChargeable === true;
    const allowedReasons = Array.isArray(settings?.nonChargeableReasons)
      ? settings.nonChargeableReasons.map((reason) => String(reason || "").trim().slice(0, 100)).filter(Boolean).slice(0, 30)
      : ["Complimentary", "Staff meal", "Customer recovery", "Promotion"];
    const reason = String(body.nonChargeableReason || "").trim().slice(0, 100);
    if (nonChargeable && (!reason || !allowedReasons.includes(reason))) throw fail(400, "Choose a valid non-chargeable reason.");

    const paymentMode = String(body.paymentMode || "full").trim().toLowerCase();
    if (!nonChargeable && !["full", "split", "partial"].includes(paymentMode)) throw fail(400, "Choose full, split, or partial payment.");
    const isPartial = !nonChargeable && paymentMode === "partial";
    const keepOpen = body.keepOpen === true && !nonChargeable && !isPartial;
    const methodLabel = String(body.paymentMethod || "").trim().slice(0, 50) || (nonChargeable ? "Non-chargeable" : "Payment");
    const sourcePayments = nonChargeable
      ? [{ method: "Non-chargeable", amount: 0 }]
      : (Array.isArray(body.payments) ? body.payments : []);
    if (!sourcePayments.length || sourcePayments.length > 10) throw fail(400, "Add one to ten valid payment entries.");
    const payments = sourcePayments.map((payment) => ({
      method: String(payment?.method || "").trim().slice(0, 50),
      amount: money(Number(payment?.amount)),
    }));
    if (!nonChargeable && payments.some((payment) => !payment.method || !Number.isFinite(payment.amount) || payment.amount < 0)) {
      throw fail(400, "Add a valid payment method and amount.");
    }
    if (nonChargeable && payments[0].amount !== 0) throw fail(400, "A non-chargeable sale cannot collect a payment.");

    if (!nonChargeable && !keepOpen && !isPartial && paymentMode === "full" && payments.length === 1) payments[0].amount = remaining;
    const currentAmount = money(payments.reduce((sum, payment) => sum + payment.amount, 0));
    if (!nonChargeable && (keepOpen || isPartial) && (currentAmount <= 0 || currentAmount >= remaining)) {
      throw fail(400, "A partial payment must be greater than zero and less than the remaining balance.");
    }
    if (!nonChargeable && !keepOpen && !isPartial && Math.abs(currentAmount - remaining) > 0.01) {
      throw fail(400, `Payments total ${currentAmount.toFixed(2)}, but the remaining balance is ${remaining.toFixed(2)}.`);
    }

    const customerSupplied = Object.prototype.hasOwnProperty.call(body, "customerId") || Object.prototype.hasOwnProperty.call(body, "customer_id");
    const rawCustomerId = customerSupplied ? (body.customerId ?? body.customer_id) : order.customer_id;
    let customerId = rawCustomerId === null || rawCustomerId === undefined || rawCustomerId === "" ? null : Number(rawCustomerId);
    if (customerId !== null) {
      if (!Number.isSafeInteger(customerId) || customerId <= 0) {
        customerId = null;
      } else {
        const customer = await env.DB.prepare("SELECT id FROM customers WHERE id = ? AND business_id = ? LIMIT 1").bind(customerId, businessId).first();
        if (!customer) customerId = null;
      }
    }

    const nextStatus = keepOpen ? (isQrOrder ? order.status : "Open") : "Completed";
    const invoiceStatus = nonChargeable ? "Non-chargeable" : (keepOpen || isPartial) ? "Partially Paid" : "Paid";
    const paymentMethod = nonChargeable ? "Non-chargeable" : methodLabel;
    const paymentDescription = nonChargeable
      ? `Non-chargeable sale recorded · ${reason}.`
      : payments.map((payment) => `${payment.method}: ${payment.amount.toFixed(2)}`).join(" · ");
    const oldInvoice = await env.DB.prepare("SELECT id FROM invoices WHERE business_id = ? AND order_id = ? LIMIT 1").bind(businessId, orderId).first();

    let invoiceSequence = null;
    let invoicePrefix = String(settings.invoicePrefix ?? "INV-").slice(0, 24);
    const invoicePadding = Math.max(1, Math.min(12, Math.floor(Number(settings.invoiceNumberPadding) || 6)));
    if (!oldInvoice) {
      const invoiceStart = Math.max(1, Math.floor(Number(settings.invoiceSequenceStart) || 1));
      const suffixStart = invoicePrefix.length + 1;
      const maxInvoice = await env.DB.prepare(`
        SELECT MAX(CAST(substr(invoice_number, ?) AS INTEGER)) AS max_number
        FROM invoices
        WHERE business_id = ? AND substr(invoice_number, 1, ?) = ?
          AND substr(invoice_number, ?) <> ''
          AND substr(invoice_number, ?) NOT GLOB '*[^0-9]*'
      `).bind(suffixStart, businessId, invoicePrefix.length, invoicePrefix, suffixStart, suffixStart).first();
      const counter = await env.DB.prepare("SELECT next_number FROM invoice_number_counters WHERE business_id = ? LIMIT 1").bind(businessId).first();
      invoiceSequence = Math.max(invoiceStart, Number(counter?.next_number) || 1, (Number(maxInvoice?.max_number) || 0) + 1);
    }

    const expectedCollectedAfter = money(collectedBefore + currentAmount);
const invoiceEligibility = `EXISTS (
  SELECT 1 FROM orders invoice_order
  LEFT JOIN (
    SELECT order_id, business_id, SUM(amount) AS collected
    FROM payments WHERE payment_status = 'Success'
    GROUP BY order_id, business_id
  ) invoice_paid ON invoice_paid.order_id = invoice_order.id AND invoice_paid.business_id = invoice_order.business_id
  WHERE invoice_order.id = ? AND invoice_order.business_id = ?
    AND (LOWER(COALESCE(invoice_order.payment_method, '')) LIKE '%non-chargeable%'
      OR COALESCE(invoice_paid.collected, 0) + 0.009 >= ?)
)`;
    const statements = [
      env.DB.prepare(`
        UPDATE orders SET customer_id = ?, payment_method = ?, status = ?, non_chargeable_reason = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND business_id = ? AND status = ? AND total = ?
          AND COALESCE((SELECT SUM(amount) FROM payments WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'), 0) = ?
      `).bind(customerId, paymentMethod, nextStatus, nonChargeable ? reason : null, orderId, businessId, order.status, order.total, orderId, businessId, collectedBefore),
      env.DB.prepare(`
        INSERT INTO payments (order_id, order_number, amount, payment_method, payment_status, transaction_id, business_id)
        SELECT ?, ?, CAST(json_extract(value, '$.amount') AS REAL), json_extract(value, '$.method'), 'Success', NULL, ?
        FROM json_each(?) WHERE changes() = 1
      `).bind(orderId, order.order_number, businessId, JSON.stringify(payments)),
      env.DB.prepare(`
        INSERT INTO loyalty_transactions (customer_id, points, transaction_type, reference_type, reference_id, note, business_id)
        SELECT o.customer_id, CAST(p.amount * COALESCE(ls.points_per_currency, 1) AS INTEGER), 'Earned', 'Payment', p.id, 'Points earned from bill', o.business_id
        FROM payments p
        JOIN orders o ON o.id = p.order_id AND o.business_id = p.business_id
        LEFT JOIN loyalty_settings ls ON ls.business_id = o.business_id
        WHERE p.order_id = ? AND p.business_id = ? AND p.payment_status = 'Success'
          AND o.customer_id IS NOT NULL AND COALESCE(ls.enabled, 1) = 1
          AND CAST(p.amount * COALESCE(ls.points_per_currency, 1) AS INTEGER) > 0
        ON CONFLICT(reference_type, reference_id, transaction_type) DO NOTHING
      `).bind(orderId, businessId),
      env.DB.prepare(`
        INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id)
        SELECT ?, 'Payment recorded', ?, COALESCE(u.display_name, u.username, 'Staff'), ?, ?
        FROM app_users u WHERE u.id = ? AND u.business_id = ? AND changes() = ?
        UNION ALL
        SELECT ?, 'Payment recorded', ?, 'Staff', ?, NULL
        WHERE changes() = ? AND NOT EXISTS (SELECT 1 FROM app_users WHERE id = ? AND business_id = ?)
      `).bind(orderId, paymentDescription, businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId, payments.length,
        orderId, paymentDescription, businessId, payments.length, Number(bridgeClaims.sub), businessId),
    ];
    if (!keepOpen) {
      statements.push(env.DB.prepare(`
        INSERT INTO order_activity (order_id, event_type, description, actor, business_id, actor_user_id)
        SELECT ?, 'Order completed', 'Sale completed.', COALESCE(u.display_name, u.username, 'Staff'), ?, ?
        FROM app_users u WHERE u.id = ? AND u.business_id = ? AND changes() = 1
        UNION ALL
        SELECT ?, 'Order completed', 'Sale completed.', 'Staff', ?, NULL
        WHERE changes() = 1 AND NOT EXISTS (SELECT 1 FROM app_users WHERE id = ? AND business_id = ?)
      `).bind(orderId, businessId, Number(bridgeClaims.sub), Number(bridgeClaims.sub), businessId,
        orderId, businessId, Number(bridgeClaims.sub), businessId));
    }

    if (!oldInvoice) {
      statements.push(env.DB.prepare(`
        INSERT INTO invoice_number_counters (business_id, next_number)
    SELECT ?, ? + 1 WHERE ${invoiceEligibility}
        ON CONFLICT(business_id) DO UPDATE SET
          next_number = MAX(invoice_number_counters.next_number, excluded.next_number - 1) + 1,
          updated_at = CURRENT_TIMESTAMP
  `).bind(businessId, invoiceSequence, orderId, businessId, expectedCollectedAfter));
      statements.push(env.DB.prepare(`
        INSERT INTO invoices (invoice_number, order_id, customer_id, invoice_date, subtotal, gst, total, payment_method, status, business_id)
        SELECT ? || printf('%0*d', ?, counter.next_number - 1), o.id, ?, CURRENT_TIMESTAMP,
          o.subtotal, o.gst, o.total, o.payment_method,
          CASE WHEN LOWER(COALESCE(o.payment_method, '')) LIKE '%non-chargeable%' THEN 'Non-chargeable'
            WHEN COALESCE(paid.collected, 0) + 0.009 >= o.total THEN 'Paid' ELSE 'Partially Paid' END,
          o.business_id
        FROM orders o JOIN invoice_number_counters counter ON counter.business_id = o.business_id
        LEFT JOIN (SELECT order_id, business_id, SUM(amount) AS collected FROM payments WHERE payment_status = 'Success' GROUP BY order_id, business_id) paid
          ON paid.order_id = o.id AND paid.business_id = o.business_id
    WHERE o.id = ? AND o.business_id = ?
      AND (LOWER(COALESCE(o.payment_method, '')) LIKE '%non-chargeable%'
        OR COALESCE(paid.collected, 0) + 0.009 >= ?)
        ON CONFLICT(order_id) DO UPDATE SET
          customer_id = excluded.customer_id,
          payment_method = excluded.payment_method,
          status = excluded.status
  `).bind(invoicePrefix, invoicePadding, customerId, orderId, businessId, expectedCollectedAfter));
    } else {
      statements.push(env.DB.prepare(`
        UPDATE invoices SET customer_id = ?, payment_method = ?, status = ?
      WHERE business_id = ? AND order_id = ? AND ${invoiceEligibility}
    `).bind(customerId, paymentMethod, invoiceStatus, businessId, orderId, orderId, businessId, expectedCollectedAfter));
    }

    if (order.order_type === "Dine-in" && order.table_number && !keepOpen) {
      const tableNumber = String(order.table_number);
      const tableMetadata = settings.restaurantTableMetadata && typeof settings.restaurantTableMetadata === "object"
        ? settings.restaurantTableMetadata[tableNumber] : null;
      if (tableMetadata?.isTemporary === true && !isPartial) {
        statements.push(env.DB.prepare(
          "DELETE FROM restaurant_tables WHERE business_id = ? AND CAST(table_number AS TEXT) = ? " +
          "AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = 'Completed')"
        ).bind(businessId, tableNumber, orderId, businessId));
        statements.push(env.DB.prepare(
          "UPDATE app_settings SET settings = json_remove(settings, ?), updated_at = CURRENT_TIMESTAMP WHERE business_id = ?"
        ).bind("$.restaurantTableMetadata." + JSON.stringify(tableNumber), businessId));
      } else {
        statements.push(env.DB.prepare(`
          UPDATE restaurant_tables SET status = 'Available'
          WHERE business_id = ? AND table_number = ? AND status = 'Occupied'
            AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND business_id = ? AND status = 'Completed')
        `).bind(businessId, tableNumber, orderId, businessId));
      }
    }

    if (body.createKot === true && settings.kotEnabled !== false) {
      const kot = await buildKotStatements(env, businessId, { orderId });
      statements.push(...kot.statements);
    }

    const results = await env.DB.batch(statements);
    const paymentInsertIndex = 1;
    const paymentChanges = Number(results?.[paymentInsertIndex]?.meta?.changes || 0);
    if (paymentChanges !== payments.length) throw fail(409, "This order changed while payment was being recorded. Refresh it and try again.");

    const savedOrder = await env.DB.prepare(`
      SELECT id, business_id, order_number, order_type, table_number, subtotal, gst, total,
        payment_method, status, created_at, updated_at, customer_id, discount, service_charge,
        pax, non_chargeable_reason, sales_channel_key, sales_channel_name
      FROM orders WHERE id = ? AND business_id = ? LIMIT 1
    `).bind(orderId, businessId).first();
    const invoice = await env.DB.prepare("SELECT * FROM invoices WHERE order_id = ? AND business_id = ? LIMIT 1").bind(orderId, businessId).first();
    const allocationResult = await env.DB.prepare(`
      SELECT payment_method AS method, SUM(amount) AS amount
      FROM payments WHERE order_id = ? AND business_id = ? AND payment_status = 'Success'
      GROUP BY payment_method ORDER BY payment_method
    `).bind(orderId, businessId).all();
    const allocations = (allocationResult.results || []).map((row) => ({ method: row.method, amount: money(Number(row.amount || 0)) }));
    const amountCollected = money(allocations.reduce((sum, allocation) => sum + allocation.amount, 0));
    return {
      status: 200,
      success: true,
      order: savedOrder,
      invoice,
      paymentSummary: {
        total: billTotal,
        amountCollected,
        amountDue: nonChargeable ? 0 : Math.max(0, money(billTotal - amountCollected)),
        allocations,
      },
    };
  } catch (error) {
    return { status: Number(error?.status) || 500, error: error?.status ? error.message : "D1 payment settlement failed." };
  }
}
