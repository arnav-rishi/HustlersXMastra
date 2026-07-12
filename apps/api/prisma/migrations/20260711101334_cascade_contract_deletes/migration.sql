-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_contract_id_fkey";

-- DropForeignKey
ALTER TABLE "hitl_queue" DROP CONSTRAINT "hitl_queue_contract_id_fkey";

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hitl_queue" ADD CONSTRAINT "hitl_queue_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
