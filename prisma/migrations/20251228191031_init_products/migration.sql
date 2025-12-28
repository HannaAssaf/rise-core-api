-- CreateEnum
CREATE TYPE "SupplierCode" AS ENUM ('farnell', 'newark', 'element14', 'mock');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "supplier" "SupplierCode" NOT NULL,
    "supplierSku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_supplier_idx" ON "Product"("supplier");

-- CreateIndex
CREATE INDEX "Product_supplierSku_idx" ON "Product"("supplierSku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_supplier_supplierSku_key" ON "Product"("supplier", "supplierSku");
