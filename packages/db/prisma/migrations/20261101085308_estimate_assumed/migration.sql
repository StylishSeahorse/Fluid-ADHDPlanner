-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "estimateAssumed" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "user_preferences" ADD COLUMN     "defaultEstimateMinutes" INTEGER NOT NULL DEFAULT 30;
