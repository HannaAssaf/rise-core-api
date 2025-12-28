-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "raw" JSONB,
ADD COLUMN     "sourceUpdatedAt" TIMESTAMP(3);
