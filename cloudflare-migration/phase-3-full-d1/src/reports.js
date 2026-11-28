function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

function dateRange(url, fallback = "today") {
  const range = String(url.searchParams.get("range") || fallback);
  const validDate = (value) => {
    const text = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : date;
  };
  let first;
  let after;
  if (range === "custom") {
    first = validDate(url.searchParams.get("from"));
    const last = validDate(url.searchParams.get("to"));
    if (!first || !last) return { error: "Invalid custom date range" };
    if (first > last) return { error: "From date cannot be after To date" };
    after = new Date(last.getTime() + 86400000);
  } else {
    const now = new Date(Date.now() + 19800000);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (range === "yesterday") { first = new Date(today.getTime() - 86400000); after = today; }
    else if (range === "week") {
      const day = today.getUTCDay() || 7;
      first = new Date(today.getTime() - (day - 1) * 86400000);
      after = new Date(first.getTime() + 7 * 86400000);
    } else if (range === "month") {
      first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
      after = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    } else { first = today; after = new Date(today.getTime() + 86400000); }
  }
  const utc = (date) => new Date(date.getTime() - 19800000).toISOString();
  return { range, start: utc(first), end: utc(after), istFrom: first.toISOString().slice(0, 10), istTo: new Date(after.getTime() - 86400000).toISOString().slice(0, 10) };
}

const paidWhere = "p.business_id=? AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?)";
const completedJoin = "JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed'";

export async function handleReports(env, businessId, path, url) {
  const report = path.split("/").at(-1);
  const r = dateRange(url, report === "advanced" ? "month" : "today");
  if (r.error) return response({ error: r.error }, 400);
  const { start, end, istFrom, istTo } = r;

  if (report === "summary") {
    const sales = await env.DB.prepare(`SELECT COALESCE(SUM(p.amount),0) AS total_sales,COUNT(DISTINCT p.order_id) AS total_orders FROM payments p ${completedJoin} WHERE ${paidWhere}`).bind(businessId,start,end).first();
    const items = await env.DB.prepare("SELECT COALESCE(SUM(i.quantity),0) AS items_sold FROM order_items i WHERE i.business_id=? AND EXISTS(SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE p.business_id=i.business_id AND p.order_id=i.order_id AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?))").bind(businessId,start,end).first();
    const totalSales=Number(sales?.total_sales||0),totalOrders=Number(sales?.total_orders||0);
    return response({ totalSales,totalOrders,averageOrder:totalOrders?totalSales/totalOrders:0,itemsSold:Number(items?.items_sold||0) });
  }
  if (report === "payments") {
    const rows=await env.DB.prepare(`SELECT p.payment_method,COUNT(DISTINCT p.order_id) AS orders,COALESCE(SUM(p.amount),0) AS amount FROM payments p ${completedJoin} WHERE ${paidWhere} GROUP BY p.payment_method ORDER BY amount DESC`).bind(businessId,start,end).all();
    return response(rows.results||[]);
  }
  if (report === "best-items") {
    const rows=await env.DB.prepare("SELECT i.item_name,SUM(i.quantity) AS quantity_sold,COALESCE(SUM(i.line_total),0) AS revenue FROM order_items i WHERE i.business_id=? AND EXISTS(SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE p.order_id=i.order_id AND p.business_id=i.business_id AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?)) GROUP BY i.item_name ORDER BY quantity_sold DESC,revenue DESC LIMIT 10").bind(businessId,start,end).all();
    return response(rows.results||[]);
  }
  if (report === "category") {
    const rows=await env.DB.prepare("SELECT COALESCE(m.category,'Uncategorized') AS category,COALESCE(SUM(i.quantity),0) AS quantity_sold,COALESCE(SUM(i.line_total),0) AS revenue FROM order_items i LEFT JOIN menu m ON m.id=i.menu_id AND m.business_id=i.business_id WHERE i.business_id=? AND EXISTS(SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE p.order_id=i.order_id AND p.business_id=i.business_id AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?)) GROUP BY COALESCE(m.category,'Uncategorized') ORDER BY revenue DESC").bind(businessId,start,end).all();
    return response(rows.results||[]);
  }
  if (report === "order-type") {
    const rows=await env.DB.prepare("SELECT COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash '||o.order_type ELSE o.order_type END) AS order_type,COUNT(DISTINCT o.id) AS orders,COALESCE(SUM(p.amount),0) AS sales FROM orders o JOIN payments p ON p.order_id=o.id AND p.business_id=o.business_id WHERE o.business_id=? AND o.status='Completed' AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?) GROUP BY order_type ORDER BY sales DESC").bind(businessId,start,end).all();
    return response(rows.results||[]);
  }
  if (report === "daily") {
    const rows=await env.DB.prepare(`SELECT date(datetime(p.created_at,'+05:30')) AS sale_date,COUNT(DISTINCT p.order_id) AS orders,COALESCE(SUM(p.amount),0) AS sales FROM payments p ${completedJoin} WHERE ${paidWhere} GROUP BY date(datetime(p.created_at,'+05:30')) ORDER BY sale_date`).bind(businessId,start,end).all();
    return response(rows.results||[]);
  }
  if (report === "gst") {
    const row=await env.DB.prepare("SELECT COUNT(DISTINCT o.id) AS orders,COALESCE(SUM(o.subtotal),0) AS taxable_sales,COALESCE(SUM(o.gst),0) AS gst,COALESCE(SUM(o.total),0) AS total_sales FROM orders o JOIN payments p ON p.order_id=o.id AND p.business_id=o.business_id WHERE o.business_id=? AND o.status='Completed' AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?)").bind(businessId,start,end).first();
    return response(row||{orders:0,taxable_sales:0,gst:0,total_sales:0});
  }
  if (report === "sale-items-by-transaction") {
    const rows=await env.DB.prepare("SELECT COALESCE(activity.closed_at,i.invoice_date,last_payment.last_payment_time,o.updated_at,o.created_at) AS transaction_date,i.invoice_number,o.id AS order_id,o.order_number,o.order_type,o.table_number,COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash '||o.order_type ELSE o.order_type END) AS channel_label,c.name AS customer_name,payment_modes.payment_modes,oi.item_name,COALESCE(m.category,'') AS category,oi.quantity,oi.price AS unit_price,oi.line_total,o.total AS transaction_total FROM orders o LEFT JOIN invoices i ON i.order_id=o.id AND i.business_id=o.business_id LEFT JOIN customers c ON c.id=o.customer_id AND c.business_id=o.business_id JOIN order_items oi ON oi.order_id=o.id AND oi.business_id=o.business_id LEFT JOIN menu m ON m.id=oi.menu_id AND m.business_id=o.business_id LEFT JOIN (SELECT order_id,business_id,MAX(created_at) AS last_payment_time FROM payments WHERE payment_status='Success' GROUP BY order_id,business_id) last_payment ON last_payment.order_id=o.id AND last_payment.business_id=o.business_id LEFT JOIN (SELECT order_id,business_id,group_concat(payment_method,', ') AS payment_modes FROM (SELECT DISTINCT order_id,business_id,payment_method FROM payments WHERE payment_status='Success' ORDER BY payment_method) GROUP BY order_id,business_id) payment_modes ON payment_modes.order_id=o.id AND payment_modes.business_id=o.business_id LEFT JOIN (SELECT order_id,business_id,MAX(created_at) AS closed_at FROM order_activity WHERE event_type='Order completed' GROUP BY order_id,business_id) activity ON activity.order_id=o.id AND activity.business_id=o.business_id WHERE o.business_id=? AND o.status='Completed' AND datetime(COALESCE(activity.closed_at,i.invoice_date,last_payment.last_payment_time,o.updated_at,o.created_at))>=datetime(?) AND datetime(COALESCE(activity.closed_at,i.invoice_date,last_payment.last_payment_time,o.updated_at,o.created_at))<datetime(?) ORDER BY transaction_date DESC,o.id DESC,oi.id LIMIT 20000").bind(businessId,start,end).all();
    return response({items:rows.results||[]});
  }
  if (report === "qr-menu-analytics") {
    const summary=await env.DB.prepare("WITH period_events AS (SELECT id,session_key,event_type,item_count,order_id,created_at FROM qr_menu_events WHERE business_id=? AND datetime(created_at)>=datetime('now','-30 days')),latest_cart AS (SELECT e.session_key,e.item_count,e.created_at FROM period_events e WHERE e.event_type='cart_updated' AND e.id=(SELECT MAX(x.id) FROM period_events x WHERE x.session_key=e.session_key AND x.event_type='cart_updated')) SELECT SUM(CASE WHEN event_type='menu_view' THEN 1 ELSE 0 END) AS menu_views,COUNT(DISTINCT CASE WHEN event_type='menu_view' THEN session_key END) AS unique_visitors,COUNT(DISTINCT CASE WHEN event_type='cart_updated' AND item_count>0 THEN session_key END) AS carts_started,COUNT(DISTINCT CASE WHEN event_type='checkout_started' THEN session_key END) AS checkout_starts,COUNT(DISTINCT CASE WHEN event_type='order_placed' AND order_id IS NOT NULL THEN order_id END) AS orders_from_sessions,(SELECT COUNT(*) FROM latest_cart lc WHERE lc.item_count>0 AND datetime(lc.created_at)<=datetime('now','-30 minutes') AND NOT EXISTS(SELECT 1 FROM qr_menu_events e WHERE e.business_id=? AND e.session_key=lc.session_key AND e.event_type='order_placed' AND datetime(e.created_at)>=datetime(lc.created_at))) AS abandoned_carts FROM period_events").bind(businessId,businessId).first();
    const popular=await env.DB.prepare("SELECT i.menu_id,i.item_name,COALESCE(m.category,'') AS category,SUM(i.quantity) AS quantity_sold,ROUND(SUM(i.line_total),2) AS sales FROM orders o JOIN order_items i ON i.order_id=o.id AND i.business_id=o.business_id LEFT JOIN menu m ON m.id=i.menu_id AND m.business_id=o.business_id WHERE o.business_id=? AND datetime(o.created_at)>=datetime('now','-30 days') AND lower(o.status)<>'cancelled' AND (o.public_tracking_token IS NOT NULL OR upper(o.order_number) LIKE 'QR-%') GROUP BY i.menu_id,i.item_name,m.category ORDER BY quantity_sold DESC,sales DESC,i.item_name LIMIT 10").bind(businessId).all();
    const uniqueVisitors=Number(summary?.unique_visitors||0),qrOrders=Number(summary?.orders_from_sessions||0);
    return response({periodDays:30,summary:{menuViews:Number(summary?.menu_views||0),uniqueVisitors,cartsStarted:Number(summary?.carts_started||0),checkoutStarts:Number(summary?.checkout_starts||0),qrOrders,abandonedCarts:Number(summary?.abandoned_carts||0),conversionRate:uniqueVisitors?Math.round(qrOrders/uniqueVisitors*1000)/10:0},popularItems:(popular.results||[]).map(row=>({...row,quantity_sold:Number(row.quantity_sold||0),sales:Number(row.sales||0)}))});
  }
  if (report === "order-activity") {
    const rows=await env.DB.prepare("SELECT a.id,a.created_at,a.event_type,a.description,a.actor,a.actor_user_id,o.id AS order_id,o.order_number,o.order_type,o.table_number,o.status AS order_status,c.name AS customer_name FROM order_activity a JOIN orders o ON o.id=a.order_id AND o.business_id=a.business_id LEFT JOIN customers c ON c.id=o.customer_id AND c.business_id=o.business_id WHERE a.business_id=? AND datetime(a.created_at)>=datetime(?) AND datetime(a.created_at)<datetime(?) ORDER BY a.created_at DESC,a.id DESC LIMIT 2000").bind(businessId,start,end).all();
    return response({activities:rows.results||[]});
  }
  if (report === "kitchen-prep-times") {
    const rows=await env.DB.prepare("SELECT o.id AS order_id,o.order_number,o.order_type,o.table_number,k.id AS ticket_id,k.ticket_number,k.item_name,k.quantity,COALESCE(k.cancelled_quantity,0) AS cancelled_quantity,CASE WHEN k.quantity<=0 AND COALESCE(k.cancelled_quantity,0)>0 THEN 'Cancelled' ELSE k.status END AS ticket_status,COALESCE(NULLIF(kg.station,''),NULLIF(kg.name,''),'Kitchen') AS station,COALESCE(NULLIF(kg.station,''),NULLIF(kg.name,''),'Kitchen') AS station_name,k.created_at AS ticket_received_at,k.prep_started_at,k.prep_completed_at,CASE WHEN k.prep_started_at IS NOT NULL THEN ROUND((julianday(COALESCE(k.prep_completed_at,datetime('now')))-julianday(k.prep_started_at))*1440,2) ELSE NULL END AS prep_minutes,CASE WHEN k.prep_completed_at IS NOT NULL THEN ROUND((julianday(k.prep_completed_at)-julianday(k.created_at))*1440,2) WHEN k.prep_started_at IS NOT NULL AND k.status NOT IN ('Ready','Completed') THEN ROUND((julianday(datetime('now'))-julianday(k.created_at))*1440,2) WHEN k.status NOT IN ('Ready','Completed') AND NOT (k.quantity<=0 AND COALESCE(k.cancelled_quantity,0)>0) THEN ROUND((julianday(datetime('now'))-julianday(k.created_at))*1440,2) ELSE NULL END AS elapsed_minutes FROM kot k JOIN orders o ON o.id=k.order_id AND o.business_id=k.business_id LEFT JOIN kot_groups kg ON kg.id=k.kot_group_id AND kg.business_id=k.business_id WHERE k.business_id=? AND datetime(k.created_at)>=datetime(?) AND datetime(k.created_at)<datetime(?) ORDER BY elapsed_minutes DESC,k.created_at DESC,k.ticket_number DESC,k.id DESC LIMIT 5000").bind(businessId,start,end).all();
    return response({tickets:rows.results||[]});
  }
  if (report === "order-categories") {
    const [discounts,free]=await Promise.all([
      env.DB.prepare("SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,o.discount,COALESCE(NULLIF(o.marketing_deal_name,''),NULLIF(o.discount_adjustment_name,''),'Discount') AS discount_name,o.payment_method,o.total FROM orders o WHERE o.business_id=? AND o.status='Completed' AND COALESCE(o.discount,0)>0 AND datetime(o.created_at)>=datetime(?) AND datetime(o.created_at)<datetime(?) ORDER BY o.created_at DESC,o.id DESC LIMIT 5000").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,o.non_chargeable_reason AS reason,o.total,o.payment_method FROM orders o WHERE o.business_id=? AND o.status='Completed' AND lower(COALESCE(o.payment_method,''))='non-chargeable' AND datetime(o.created_at)>=datetime(?) AND datetime(o.created_at)<datetime(?) ORDER BY o.created_at DESC,o.id DESC LIMIT 5000").bind(businessId,start,end).all(),
    ]);
    return response({discountOrders:discounts.results||[],nonChargeableOrders:free.results||[]});
  }
  if (report === "sales-summary") {
    const summary=await env.DB.prepare("WITH period_orders AS (SELECT o.id,o.subtotal,o.discount,o.service_charge,o.gst,o.total,o.pax,o.order_type,o.charge_adjustment_name FROM orders o WHERE o.business_id=? AND o.status='Completed' AND EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.business_id=o.business_id AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?))),paid_to_date AS (SELECT p.order_id,SUM(p.amount) AS amount_paid FROM payments p JOIN period_orders o ON o.id=p.order_id WHERE p.business_id=? AND p.payment_status='Success' GROUP BY p.order_id) SELECT COALESCE(SUM(o.subtotal),0) AS gross_sales,COALESCE(SUM(o.discount),0) AS discounts,COALESCE(SUM(MAX(o.subtotal-o.discount,0)),0) AS net_sales,COALESCE(SUM(o.service_charge),0) AS service_charges,COALESCE(SUM(o.gst),0) AS taxes,COALESCE(SUM(o.total-((o.subtotal-o.discount)+o.service_charge+o.gst)),0) AS rounding,COALESCE(SUM(CASE WHEN lower(COALESCE(o.order_type,'')) LIKE '%dine%' THEN COALESCE(o.pax,1) ELSE 0 END),0) AS pax,COALESCE(SUM(o.total),0) AS total_gross_revenue,COALESCE(SUM(MAX(o.total-COALESCE(p.amount_paid,0),0)),0) AS payment_balance FROM period_orders o LEFT JOIN paid_to_date p ON p.order_id=o.id").bind(businessId,start,end,businessId).first();
    const payments=await env.DB.prepare("SELECT p.payment_method,COALESCE(SUM(p.amount),0) AS amount FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE p.business_id=? AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?) GROUP BY p.payment_method ORDER BY amount DESC,p.payment_method").bind(businessId,start,end).all();
    const charges=await env.DB.prepare("SELECT COALESCE(NULLIF(trim(o.charge_adjustment_name),''),'Service charges') AS charge_name,COALESCE(SUM(o.service_charge),0) AS amount FROM orders o WHERE o.business_id=? AND o.status='Completed' AND o.service_charge>0 AND EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.business_id=o.business_id AND p.payment_status='Success' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?)) GROUP BY charge_name ORDER BY amount DESC,charge_name").bind(businessId,start,end).all();
    const keys=["gross_sales","discounts","net_sales","service_charges","taxes","rounding","pax","total_gross_revenue","payment_balance"];
    return response({range:r.range,summary:Object.fromEntries(keys.map(key=>[key,Number(summary?.[key]||0)])),payments:(payments.results||[]).map(row=>({payment_method:row.payment_method,amount:Number(row.amount||0)})),chargeBreakdown:(charges.results||[]).map(row=>({name:row.charge_name,amount:Number(row.amount||0)})),untracked:["sales_returns","direct_charges","tips","cost_of_goods_sold","materials","materials_audit","materials_voided","margin_on_net_sales"]});
  }
  if (report === "sales-audit") {
    const rows = await env.DB.prepare(`
      WITH payment_summary AS (
        SELECT business_id, order_id, SUM(amount) AS amount_collected, MIN(created_at) AS first_payment_time,
               MAX(created_at) AS last_payment_time, group_concat(DISTINCT payment_method) AS payment_modes,
               group_concat(DISTINCT transaction_id) AS transaction_ids
        FROM payments WHERE payment_status = 'Success' GROUP BY business_id, order_id
      ),
      activity_summary AS (
        SELECT a.business_id, a.order_id,
          MIN(CASE WHEN a.event_type = 'Order created' THEN a.actor END) AS created_by,
          MAX(CASE WHEN a.event_type = 'Order completed' THEN a.actor END) AS closed_by,
          MAX(CASE WHEN a.event_type = 'Order completed' THEN a.created_at END) AS closed_at,
          MAX(CASE WHEN a.event_type = 'Order voided' THEN a.created_at END) AS voided_at,
          MAX(CASE WHEN a.event_type = 'QR order accepted' THEN a.created_at END) AS accepted_at,
          MAX(CASE WHEN a.event_type = 'QR order marked ready' THEN a.created_at END) AS ready_at,
          SUM(CASE WHEN o.bill_printed_at IS NOT NULL AND datetime(a.created_at) > datetime(o.bill_printed_at) AND a.event_type = 'Closed bill edited' THEN 1 ELSE 0 END) AS modified_after_print,
          SUM(CASE WHEN a.event_type = 'Closed bill edited' THEN 1 ELSE 0 END) AS modified_after_close,
          group_concat(CASE WHEN o.bill_printed_at IS NOT NULL AND datetime(a.created_at) > datetime(o.bill_printed_at) THEN a.event_type || ': ' || NULLIF(a.description, '') END, ' | ') AS changes_after_print
        FROM order_activity a JOIN orders o ON o.id = a.order_id AND o.business_id = a.business_id
        GROUP BY a.business_id, a.order_id
      ),
      item_summary AS (SELECT business_id, order_id, COUNT(*) AS item_count, SUM(quantity) AS total_quantity FROM order_items GROUP BY business_id, order_id),
      kot_summary AS (
        SELECT k.business_id, k.order_id, group_concat(DISTINCT kg.name) AS resource_group_names, COUNT(DISTINCT k.kot_group_id) AS number_of_tickets
        FROM kot k LEFT JOIN kot_groups kg ON kg.id = k.kot_group_id AND kg.business_id = k.business_id GROUP BY k.business_id, k.order_id
      ),
      prep_summary AS (
        SELECT k.business_id, k.order_id, ROUND(AVG((julianday(k.prep_completed_at)-julianday(k.prep_started_at))*1440),2) AS average_prep_minutes,
               ROUND(MAX((julianday(k.prep_completed_at)-julianday(k.prep_started_at))*1440),2) AS longest_prep_minutes,
               group_concat(DISTINCT COALESCE(NULLIF(kg.station,''),NULLIF(kg.name,''),'Kitchen')) AS kitchen_stations
        FROM kot k LEFT JOIN kot_groups kg ON kg.id = k.kot_group_id AND kg.business_id = k.business_id
        WHERE k.prep_started_at IS NOT NULL AND k.prep_completed_at IS NOT NULL GROUP BY k.business_id, k.order_id
      )
      SELECT b.business_name,b.business_code,o.id AS order_id,o.order_number,o.order_type,o.table_number,o.pax,o.created_at,o.updated_at,
        o.subtotal,o.discount,o.service_charge,o.gst,o.total AS bill_total,CASE WHEN a.voided_at IS NOT NULL OR (o.status='Cancelled' AND a.closed_at IS NOT NULL) THEN 'Voided' ELSE o.status END AS order_status,o.notes,o.non_chargeable_reason,
        o.cancellation_reason,o.bill_printed_at,o.public_tracking_token,o.marketing_deal_name,o.discount_adjustment_name,o.customer_id,o.sales_channel_key,
        COALESCE(NULLIF(o.sales_channel_name,''),CASE WHEN o.public_tracking_token IS NOT NULL THEN 'Slash '||o.order_type ELSE o.order_type END) AS channel_label,
        i.invoice_number,i.invoice_date,c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email,c.gstin AS customer_gstin,
        c.address AS customer_address,c.city AS customer_city,c.state AS customer_state,COALESCE(p.amount_collected,0) AS amount_collected,
        CASE WHEN lower(COALESCE(o.payment_method,''))='non-chargeable' THEN 0 ELSE MAX(o.total-COALESCE(p.amount_collected,0),0) END AS amount_due,
        COALESCE(p.payment_modes,'') AS payment_modes,COALESCE(p.transaction_ids,'') AS transaction_ids,p.first_payment_time,p.last_payment_time,
        a.created_by,a.closed_by,a.closed_at,a.accepted_at,a.ready_at,COALESCE(a.modified_after_print,0) AS modified_after_print,
        COALESCE(a.modified_after_close,0) AS modified_after_close,COALESCE(a.changes_after_print,'') AS changes_after_print,
        COALESCE(items.item_count,0) AS item_count,COALESCE(items.total_quantity,0) AS total_quantity,
        COALESCE(kots.resource_group_names,'') AS resource_group_names,COALESCE(kots.number_of_tickets,0) AS number_of_tickets,
        prep.average_prep_minutes,prep.longest_prep_minutes,COALESCE(prep.kitchen_stations,'') AS kitchen_stations,
        CASE WHEN o.subtotal>0 THEN ROUND(o.discount/o.subtotal*100,2) ELSE 0 END AS discount_percent,
        MAX(o.subtotal-o.discount,0) AS net_amount,o.total-((o.subtotal-o.discount)+o.service_charge+o.gst) AS rounding_amount,
        CASE WHEN a.closed_at IS NOT NULL THEN ROUND((julianday(a.closed_at)-julianday(o.created_at))*1440,2) END AS duration_minutes,
        CASE WHEN a.accepted_at IS NOT NULL THEN ROUND((julianday(a.accepted_at)-julianday(o.created_at))*1440,2) END AS time_to_accept,
        CASE WHEN a.ready_at IS NOT NULL AND a.accepted_at IS NOT NULL THEN ROUND((julianday(a.ready_at)-julianday(a.accepted_at))*1440,2) END AS time_to_prepare,
        COALESCE(a.voided_at,o.cancelled_at,a.closed_at,i.invoice_date,p.last_payment_time,o.updated_at,o.created_at) AS business_date
      FROM orders o JOIN businesses b ON b.id=o.business_id
      LEFT JOIN invoices i ON i.order_id=o.id AND i.business_id=o.business_id
      LEFT JOIN customers c ON c.id=o.customer_id AND c.business_id=o.business_id
      LEFT JOIN payment_summary p ON p.order_id=o.id AND p.business_id=o.business_id
      LEFT JOIN activity_summary a ON a.order_id=o.id AND a.business_id=o.business_id
      LEFT JOIN item_summary items ON items.order_id=o.id AND items.business_id=o.business_id
      LEFT JOIN kot_summary kots ON kots.order_id=o.id AND kots.business_id=o.business_id
      LEFT JOIN prep_summary prep ON prep.order_id=o.id AND prep.business_id=o.business_id
      WHERE o.business_id=? AND (o.status='Completed' OR (o.status='Cancelled' AND (a.voided_at IS NOT NULL OR a.closed_at IS NOT NULL)))
        AND datetime(COALESCE(a.voided_at,o.cancelled_at,a.closed_at,i.invoice_date,p.last_payment_time,o.updated_at,o.created_at))>=datetime(?)
        AND datetime(COALESCE(a.voided_at,o.cancelled_at,a.closed_at,i.invoice_date,p.last_payment_time,o.updated_at,o.created_at))<datetime(?)
      ORDER BY business_date DESC,o.id DESC
    `).bind(businessId,start,end).all();
    return response({transactions:rows.results||[]});
  }
  if (report === "advanced") {
    const [hourly,weekday,dayparts,customers,cancelled,discountOrders,nonChargeableOrders,expenseTotal]=await Promise.all([
      env.DB.prepare("SELECT CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER) AS hour,COUNT(DISTINCT p.order_id) AS orders,COALESCE(SUM(p.amount),0) AS sales FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE "+paidWhere+" GROUP BY hour ORDER BY hour").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT CASE CAST(strftime('%w',datetime(p.created_at,'+05:30')) AS INTEGER) WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed' WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' ELSE 'Sat' END AS day,((CAST(strftime('%w',datetime(p.created_at,'+05:30')) AS INTEGER)+6)%7)+1 AS day_no,COUNT(DISTINCT p.order_id) AS orders,COALESCE(SUM(p.amount),0) AS sales FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE "+paidWhere+" GROUP BY day_no ORDER BY day_no").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT CASE WHEN CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER) BETWEEN 5 AND 10 THEN 'Breakfast' WHEN CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER) BETWEEN 11 AND 14 THEN 'Lunch' WHEN CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER) BETWEEN 15 AND 17 THEN 'Afternoon' WHEN CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER) BETWEEN 18 AND 21 THEN 'Evening' ELSE 'Late night' END AS daypart,MIN(CASE WHEN CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER)<5 THEN CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER)+24 ELSE CAST(strftime('%H',datetime(p.created_at,'+05:30')) AS INTEGER) END) AS sort_hour,COUNT(DISTINCT p.order_id) AS orders,COALESCE(SUM(p.amount),0) AS sales FROM payments p JOIN orders o ON o.id=p.order_id AND o.business_id=p.business_id AND o.status='Completed' WHERE "+paidWhere+" GROUP BY daypart ORDER BY sort_hour").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT COALESCE(c.name,'Walk-in') AS customer,COUNT(DISTINCT o.id) AS orders,COALESCE(SUM(o.total),0) AS sales FROM orders o LEFT JOIN customers c ON c.id=o.customer_id AND c.business_id=o.business_id JOIN payments p ON p.order_id=o.id AND p.business_id=o.business_id AND p.payment_status='Success' WHERE o.business_id=? AND o.status='Completed' AND datetime(p.created_at)>=datetime(?) AND datetime(p.created_at)<datetime(?) GROUP BY c.name ORDER BY sales DESC LIMIT 20").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT o.id AS order_id,o.order_number,o.order_type,o.table_number,CASE WHEN EXISTS(SELECT 1 FROM order_activity a WHERE a.order_id=o.id AND a.business_id=o.business_id AND a.event_type IN ('Order voided','Order completed')) THEN 'Voided' ELSE 'Cancelled' END AS action,COALESCE(o.cancelled_at,o.updated_at,o.created_at) AS cancelled_at,o.cancellation_reason AS reason,o.cancelled_by_user_id,COALESCE(NULLIF(trim(u.display_name),''),NULLIF(trim(u.username),''),'Unknown user') AS cancelled_by_user_name,o.total AS value FROM orders o LEFT JOIN app_users u ON u.id=o.cancelled_by_user_id AND u.business_id=o.business_id WHERE o.status='Cancelled' AND o.business_id=? AND datetime(COALESCE(o.cancelled_at,o.updated_at,o.created_at))>=datetime(?) AND datetime(COALESCE(o.cancelled_at,o.updated_at,o.created_at))<datetime(?) ORDER BY cancelled_at DESC,o.id DESC LIMIT 5000").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,o.discount,COALESCE(NULLIF(o.marketing_deal_name,''),NULLIF(o.discount_adjustment_name,''),'Discount') AS discount_name,o.payment_method,o.total FROM orders o WHERE o.business_id=? AND o.status='Completed' AND COALESCE(o.discount,0)>0 AND datetime(o.created_at)>=datetime(?) AND datetime(o.created_at)<datetime(?) ORDER BY o.created_at DESC,o.id DESC LIMIT 5000").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT o.id AS order_id,o.order_number,o.created_at,o.order_type,o.table_number,o.non_chargeable_reason AS reason,o.total,o.payment_method FROM orders o WHERE o.business_id=? AND o.status='Completed' AND lower(COALESCE(o.payment_method,''))='non-chargeable' AND datetime(o.created_at)>=datetime(?) AND datetime(o.created_at)<datetime(?) ORDER BY o.created_at DESC,o.id DESC LIMIT 5000").bind(businessId,start,end).all(),
      env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS amount FROM expenses WHERE business_id=? AND date(expense_date)>=date(?) AND date(expense_date)<=date(?)").bind(businessId,istFrom,istTo).first(),
    ]);
    return response({hourly:hourly.results||[],weekday:weekday.results||[],dayparts:dayparts.results||[],customers:customers.results||[],cancelled:cancelled.results||[],discountOrders:discountOrders.results||[],nonChargeableOrders:nonChargeableOrders.results||[],expenseTotal:Number(expenseTotal?.amount||0),warnings:[]});
  }
  return response({error:"Not found"},404);
}

export async function handleDashboardStats(env, businessId) {
  const row = await env.DB.prepare(`
    WITH bounds AS (
      SELECT datetime('now', '+05:30', 'start of day', '-05:30') AS day_start,
             datetime('now', '+05:30', 'start of day', '+1 day', '-05:30') AS day_end
    )
    SELECT
      COALESCE(SUM(CASE WHEN o.status = 'Completed' AND datetime(o.created_at) >= bounds.day_start AND datetime(o.created_at) < bounds.day_end THEN o.total ELSE 0 END), 0) AS todaySales,
      SUM(CASE WHEN datetime(o.created_at) >= bounds.day_start AND datetime(o.created_at) < bounds.day_end THEN 1 ELSE 0 END) AS todayOrders,
      SUM(CASE WHEN LOWER(COALESCE(o.status, '')) NOT IN ('completed', 'cancelled', '') THEN 1 ELSE 0 END) AS pendingOrders,
      (SELECT COUNT(*) FROM customers WHERE business_id = ?) AS customers,
      COUNT(*) AS totalOrders,
      COALESCE(SUM(CASE WHEN o.status = 'Completed' THEN o.total ELSE 0 END), 0) AS totalRevenue
    FROM orders o CROSS JOIN bounds WHERE o.business_id = ?
  `).bind(businessId, businessId).first();
  return response({
    todaySales: Number(row?.todaySales || 0), todayOrders: Number(row?.todayOrders || 0),
    pendingOrders: Number(row?.pendingOrders || 0), customers: Number(row?.customers || 0),
    totalOrders: Number(row?.totalOrders || 0), totalRevenue: Number(row?.totalRevenue || 0),
  });
}
