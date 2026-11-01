-- CreateEnum
CREATE TYPE "DeadlineKind" AS ENUM ('SOFT', 'HARD');

-- CreateEnum
CREATE TYPE "PreferredWindow" AS ENUM ('MORNING', 'AFTERNOON', 'EVENING');

-- CreateEnum
CREATE TYPE "SchedulingMode" AS ENUM ('MANUAL', 'ASSISTED', 'HYBRID', 'AUTOMATIC');

-- AlterEnum
ALTER TYPE "BlockState" ADD VALUE 'MISSED';

-- AlterTable
ALTER TABLE "board_columns" ADD COLUMN     "autoSchedule" BOOLEAN;

-- AlterTable
ALTER TABLE "plan_versions" ADD COLUMN     "autoApplied" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "disruptionScore" DOUBLE PRECISION,
ADD COLUMN     "gateReason" TEXT,
ADD COLUMN     "inputDigest" TEXT,
ADD COLUMN     "issues" JSONB,
ADD COLUMN     "overtimeProposals" JSONB,
ADD COLUMN     "staleCalendarSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "importance" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "scheduled_blocks" ADD COLUMN     "committedDay" TIMESTAMPTZ(3),
ADD COLUMN     "explanation" JSONB,
ADD COLUMN     "explanationText" TEXT,
ADD COLUMN     "overlapAck" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "autoSchedule" BOOLEAN,
ADD COLUMN     "deadlineKind" "DeadlineKind" NOT NULL DEFAULT 'SOFT',
ADD COLUMN     "preferredWindow" "PreferredWindow";

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "horizonDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "hybridThreshold" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "maxDailyWorkMinutes" INTEGER,
ADD COLUMN     "schedulingMode" "SchedulingMode" NOT NULL DEFAULT 'ASSISTED';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "planEpoch" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "scheduled_blocks_userId_startsAt_idx" ON "scheduled_blocks"("userId", "startsAt");

-- AddForeignKey
ALTER TABLE "scheduled_blocks" ADD CONSTRAINT "scheduled_blocks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Owner on every session ──────────────────────────────────────────────────
-- Denormalized from the task so the exclusion constraint below can compare
-- one person's sessions. A trigger fills it, so no code path that creates a
-- block can forget it.
UPDATE "scheduled_blocks" b SET "userId" = t."userId" FROM "tasks" t WHERE t.id = b."taskId" AND b."userId" IS NULL;

CREATE OR REPLACE FUNCTION scheduled_blocks_owner() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS NULL OR TG_OP = 'UPDATE' AND NEW."taskId" IS DISTINCT FROM OLD."taskId" THEN
    SELECT "userId" INTO NEW."userId" FROM "tasks" WHERE id = NEW."taskId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER scheduled_blocks_owner
  BEFORE INSERT OR UPDATE OF "taskId", "userId" ON "scheduled_blocks"
  FOR EACH ROW EXECUTE FUNCTION scheduled_blocks_owner();

ALTER TABLE "scheduled_blocks" ADD CONSTRAINT scheduled_blocks_positive CHECK ("endsAt" > "startsAt");

-- ── No two accepted sessions of one person at once (§17.6) ─────────────────
-- Defence in depth behind the engine, which never produces an overlap. A
-- session someone deliberately placed over other work carries overlapAck and
-- is exempt. Overlaps already in the data predate this rule: they are marked
-- acknowledged rather than deleted, so upgrading never loses a session.
CREATE EXTENSION IF NOT EXISTS btree_gist;

UPDATE "scheduled_blocks" a SET "overlapAck" = true
WHERE a.state = 'ACCEPTED' AND EXISTS (
  SELECT 1 FROM "scheduled_blocks" b
  WHERE b.id <> a.id AND b.state = 'ACCEPTED' AND b."userId" = a."userId"
    AND tstzrange(b."startsAt", b."endsAt") && tstzrange(a."startsAt", a."endsAt")
);

ALTER TABLE "scheduled_blocks" ADD CONSTRAINT scheduled_blocks_no_overlap
  EXCLUDE USING gist ("userId" WITH =, tstzrange("startsAt", "endsAt") WITH &&)
  WHERE (state = 'ACCEPTED' AND NOT "overlapAck");

-- Projects: importance is 0–2.
ALTER TABLE "projects" ADD CONSTRAINT projects_importance_range CHECK ("importance" BETWEEN 0 AND 2);
