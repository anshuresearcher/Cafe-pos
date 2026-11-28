-- Run each statement separately in Supabase SQL Editor.
-- CONCURRENTLY avoids holding a write-blocking lock while existing POS traffic continues.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kot_business_id_id
    ON public.kot (business_id, id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_activity_business_id_id
    ON public.order_activity (business_id, id);
