-- Multi-tenant composite PK migration.
-- Before: PK on FB-native IDs (group_id, post_id, comment_id, user_id) meant
-- only ONE tenant could hold each FB row. agent/upload.ts had a "collision
-- guard" that silently skipped rows already owned by another tenant. For 10
-- POD customers crawling overlapping groups this was a feature regression —
-- customer 2 would get zero leads from popular shared groups.
--
-- After: composite (tenant_id, <fb_id>) — every tenant can hold their own
-- copy of the same FB content independently. The collision guard is then
-- redundant and is removed from agent/upload.ts.
--
-- Foreign keys are remapped to composite as well.

BEGIN;

-- 1. Drop existing FKs that reference the soon-to-change PKs/UNIQUEs.
ALTER TABLE fact_group_post         DROP CONSTRAINT fact_group_post_group_id_fkey;
ALTER TABLE fact_group_post_comment DROP CONSTRAINT fact_group_post_comment_post_id_fkey;
ALTER TABLE fact_lead               DROP CONSTRAINT fact_lead_post_id_fkey;
ALTER TABLE fact_lead               DROP CONSTRAINT fact_lead_group_id_fkey;

-- 2. dim_group: composite PK
ALTER TABLE dim_group DROP CONSTRAINT dim_group_pkey;
ALTER TABLE dim_group ADD CONSTRAINT dim_group_pkey PRIMARY KEY (tenant_id, group_id);

-- 3. dim_user: composite PK
ALTER TABLE dim_user  DROP CONSTRAINT dim_user_pkey;
ALTER TABLE dim_user  ADD CONSTRAINT dim_user_pkey  PRIMARY KEY (tenant_id, user_id);

-- 4. fact_group_post: composite PK + composite FK to dim_group
ALTER TABLE fact_group_post DROP CONSTRAINT fact_group_post_pkey;
ALTER TABLE fact_group_post ADD CONSTRAINT fact_group_post_pkey PRIMARY KEY (tenant_id, post_id);
ALTER TABLE fact_group_post ADD CONSTRAINT fact_group_post_group_id_fkey
  FOREIGN KEY (tenant_id, group_id) REFERENCES dim_group(tenant_id, group_id);

-- 5. fact_group_post_comment: composite PK + composite FK
ALTER TABLE fact_group_post_comment DROP CONSTRAINT fact_group_post_comment_pkey;
ALTER TABLE fact_group_post_comment ADD CONSTRAINT fact_group_post_comment_pkey
  PRIMARY KEY (tenant_id, comment_id);
ALTER TABLE fact_group_post_comment ADD CONSTRAINT fact_group_post_comment_post_id_fkey
  FOREIGN KEY (tenant_id, post_id) REFERENCES fact_group_post(tenant_id, post_id) ON DELETE CASCADE;

-- 6. fact_lead: change UNIQUE from (post_id) → (tenant_id, post_id) + composite FKs.
--    Note: detector.ts ON CONFLICT must update from (post_id) → (tenant_id, post_id)
--    in lockstep with this migration.
ALTER TABLE fact_lead DROP CONSTRAINT fact_lead_post_id_key;
ALTER TABLE fact_lead ADD CONSTRAINT fact_lead_tenant_post_key UNIQUE (tenant_id, post_id);
ALTER TABLE fact_lead ADD CONSTRAINT fact_lead_post_id_fkey
  FOREIGN KEY (tenant_id, post_id) REFERENCES fact_group_post(tenant_id, post_id) ON DELETE CASCADE;
ALTER TABLE fact_lead ADD CONSTRAINT fact_lead_group_id_fkey
  FOREIGN KEY (tenant_id, group_id) REFERENCES dim_group(tenant_id, group_id);

COMMIT;
