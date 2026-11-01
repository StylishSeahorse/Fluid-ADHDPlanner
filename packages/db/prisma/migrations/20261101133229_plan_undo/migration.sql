-- AlterEnum
ALTER TYPE "PlanStatus" ADD VALUE 'REVERTED';

-- AlterTable
ALTER TABLE "user_preferences" ALTER COLUMN "autoAcceptSeconds" SET DEFAULT 0;

-- Auto-accept was never wired up, so nobody chose 30 seconds: it was only the
-- default. With replans now running on their own, accepting silently after a
-- countdown nobody may be watching would break "nothing reaches your calendar
-- until you accept" in Assisted mode. It is opt-in from Settings instead.
UPDATE "user_preferences" SET "autoAcceptSeconds" = 0 WHERE "autoAcceptSeconds" = 30;
