/*
  Warnings:

  - A unique constraint covering the columns `[supplierKey]` on the table `Product` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `supplierKey` to the `Product` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Product_supplier_idx";

-- DropIndex
DROP INDEX "Product_supplier_supplierSku_key";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "supplierKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Product_supplierKey_key" ON "Product"("supplierKey");
