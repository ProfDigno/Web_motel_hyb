BEGIN;
ALTER TABLE occupancy_snapshot ADD COLUMN IF NOT EXISTS minimum_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE occupancy_snapshot ADD COLUMN IF NOT EXISTS additional_unit_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE occupancy_snapshot ADD COLUMN IF NOT EXISTS consumption_amount numeric NOT NULL DEFAULT 0;
COMMIT;
