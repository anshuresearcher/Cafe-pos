BEGIN;
CREATE TABLE IF NOT EXISTS public.network_usage_hourly (
    bucket_start TIMESTAMPTZ NOT NULL,
    business_id INTEGER NOT NULL DEFAULT 0,
    device_id VARCHAR(128) NOT NULL DEFAULT '',
    user_id INTEGER NOT NULL DEFAULT 0,
    route_key VARCHAR(240) NOT NULL,
    http_method VARCHAR(10) NOT NULL,
    feature VARCHAR(32) NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 0,
    response_bytes BIGINT NOT NULL DEFAULT 0,
    response_time_ms_total NUMERIC(20,3) NOT NULL DEFAULT 0,
    response_time_ms_max NUMERIC(20,3) NOT NULL DEFAULT 0,
    error_count BIGINT NOT NULL DEFAULT 0,
    db_query_count BIGINT NOT NULL DEFAULT 0,
    db_duration_ms_total NUMERIC(20,3) NOT NULL DEFAULT 0,
    db_rows BIGINT NOT NULL DEFAULT 0,
    db_result_bytes_est BIGINT NOT NULL DEFAULT 0,
    db_size_sample_count BIGINT NOT NULL DEFAULT 0,
    db_error_count BIGINT NOT NULL DEFAULT 0,
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (bucket_start, business_id, device_id, user_id, route_key, http_method, feature)
);
CREATE INDEX IF NOT EXISTS idx_network_usage_hourly_business
    ON public.network_usage_hourly (bucket_start DESC, business_id);
CREATE INDEX IF NOT EXISTS idx_network_usage_hourly_endpoint
    ON public.network_usage_hourly (bucket_start DESC, route_key);
CREATE INDEX IF NOT EXISTS idx_network_usage_hourly_device
    ON public.network_usage_hourly (bucket_start DESC, business_id, device_id);

ALTER TABLE public.network_usage_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_usage_hourly FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS network_usage_hourly_tenant_policy ON public.network_usage_hourly;
CREATE POLICY network_usage_hourly_tenant_policy ON public.network_usage_hourly
    USING (
        current_setting('app.system_mode', true) = 'on'
        OR business_id::text = NULLIF(current_setting('app.business_id', true), '')
    )
    WITH CHECK (
        current_setting('app.system_mode', true) = 'on'
        OR business_id::text = NULLIF(current_setting('app.business_id', true), '')
    );
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.network_usage_hourly TO cafe_pos_runtime;
COMMIT;
