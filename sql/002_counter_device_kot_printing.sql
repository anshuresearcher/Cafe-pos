-- Run this once in the Supabase SQL editor before deploying the server update.
-- The two tables are tenant isolated and store the counter-device print lease
-- plus new KOT tickets waiting to be printed.

CREATE TABLE IF NOT EXISTS public.kot_device_print_hosts (
    business_id INTEGER PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    host_device_id VARCHAR(128),
    last_heartbeat TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.kot_device_print_jobs (
    id BIGSERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    order_id INTEGER NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    ticket_number INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_by_device_id VARCHAR(128),
    lease_until TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    printed_at TIMESTAMPTZ,
    UNIQUE (business_id, order_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_kot_device_print_jobs_pending
    ON public.kot_device_print_jobs(business_id, status, next_attempt_at, id);

ALTER TABLE public.kot_device_print_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kot_device_print_hosts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.kot_device_print_hosts;
CREATE POLICY tenant_isolation ON public.kot_device_print_hosts
    USING (
        current_setting('app.system_mode', true) = 'on'
        OR business_id = NULLIF(current_setting('app.business_id', true), '')::INTEGER
    )
    WITH CHECK (
        current_setting('app.system_mode', true) = 'on'
        OR business_id = NULLIF(current_setting('app.business_id', true), '')::INTEGER
    );

ALTER TABLE public.kot_device_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kot_device_print_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.kot_device_print_jobs;
CREATE POLICY tenant_isolation ON public.kot_device_print_jobs
    USING (
        current_setting('app.system_mode', true) = 'on'
        OR business_id = NULLIF(current_setting('app.business_id', true), '')::INTEGER
    )
    WITH CHECK (
        current_setting('app.system_mode', true) = 'on'
        OR business_id = NULLIF(current_setting('app.business_id', true), '')::INTEGER
    );

-- The server uses the restricted cafe_pos_runtime role. Table grants allow the
-- API to perform its normal operations; the RLS policies above still limit each
-- request to the active business.
GRANT SELECT, INSERT, UPDATE ON public.kot_device_print_hosts TO cafe_pos_runtime;
GRANT SELECT, INSERT, UPDATE ON public.kot_device_print_jobs TO cafe_pos_runtime;
GRANT USAGE, SELECT ON SEQUENCE public.kot_device_print_jobs_id_seq TO cafe_pos_runtime;
