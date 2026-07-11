/**
 * LexGuard AI — Compliance Agent (#9)
 * Checks clauses against jurisdiction_rules + regulatory_documents.
 * Conservative: flag if uncertain. GDPR/CCPA aware. Per PRD Appendix A.4
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import type { RetrievedItem } from "@lexguard/shared/schemas";
import { gpt4o, getAzureOpenAIClient, getChatDeployment } from "./models";

export interface ComplianceAgentInput {
  contractId: string; orgId: string; jurisdiction: string;
  clauseIndex: number; clauseType: string; clauseText: string;
  jurisdictionRules: RetrievedItem[]; regulatoryDocs: RetrievedItem[];
}

export interface ComplianceResult {
  clauseIndex: number; isCompliant: boolean;
  findings: Array<{ regulation: string; section: string; offendingLanguage: string; requiredCorrection: string; severity: string }>;
  jurisdictionVerified: boolean; requiresHitl: boolean;
  complianceLatencyMs: number; promptHash: string;
}

const checkComplianceTool = createTool({
  id: "check_compliance",
  description: "Checks a clause against jurisdiction rules using GPT-4o + CRISPE (conservative, flag-if-uncertain).",
  inputSchema: z.object({
    clauseType: z.string(), clauseIndex: z.number(), clauseText: z.string(),
    jurisdiction: z.string(), orgId: z.string(),
    jurisdictionRulesContext: z.string(), regulatoryDocsContext: z.string(),
  }),
  outputSchema: z.object({
    isCompliant: z.boolean(), jurisdictionVerified: z.boolean(),
    findings: z.array(z.object({ regulation: z.string(), section: z.string(), offendingLanguage: z.string(), requiredCorrection: z.string(), severity: z.string() })),
    promptHash: z.string(), inputTokens: z.number(), outputTokens: z.number(), latencyMs: z.number(),
  }),
  execute: async (input, context) => {
    const openai = getAzureOpenAIClient();
    const prompt = `ROLE: Regulatory Compliance Specialist for ${input.jurisdiction}.
Check this ${input.clauseType} clause (index ${input.clauseIndex}) against jurisdiction rules.
RULES: ${input.jurisdictionRulesContext || "None retrieved — mark jurisdictionVerified=false."}
REGULATORY DOCS: ${input.regulatoryDocsContext || "None retrieved."}
RULES: Flag if uncertain. Cite specific regulation+section. GDPR: flag data processing without DPA. CCPA: flag California data without opt-out.
CLAUSE: ${input.clauseText.slice(0, 800)}
Return JSON: {"isCompliant":bool,"jurisdictionVerified":bool,"findings":[{"regulation":"...","section":"...","offendingLanguage":"...","requiredCorrection":"...","severity":"Blocking|Warning|Advisory"}]}`;
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    const start = Date.now();
    let result: any = null; let inputTokens = 0, outputTokens = 0;
    try {
      const response = await openai.chat.completions.create({
        model: getChatDeployment(), response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt }, { role: "user", content: "Check compliance now." }],
      });
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
      result = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      recordLlmTokens(input.orgId, getChatDeployment(), inputTokens, outputTokens);
    } catch {
      result = { isCompliant: false, jurisdictionVerified: false, findings: [{ regulation: "Unknown", section: "N/A", offendingLanguage: input.clauseText.slice(0, 80), requiredCorrection: "Manual review required", severity: "Warning" }] };
    }
    const findings = Array.isArray(result.findings)
      ? result.findings.map((item: any) => ({
          regulation: item.regulation ?? "Unknown",
          section: item.section ?? "N/A",
          offendingLanguage: item.offendingLanguage ?? "",
          requiredCorrection: item.requiredCorrection ?? "Manual review required",
          severity: item.severity ?? "Warning",
        }))
      : [];

    return { isCompliant: result.isCompliant ?? false, jurisdictionVerified: result.jurisdictionVerified ?? false, findings, promptHash, inputTokens, outputTokens, latencyMs: Date.now() - start };
  },
});

export const complianceAgent: Agent = new Agent({
  id: "compliance-agent",
  name: "compliance-agent",
  instructions: "Check legal clauses for compliance using check_compliance. Flag if uncertain. Cite specific regulation+section. GDPR/CCPA aware. Escalate to HITL if jurisdictionVerified=false.",
  model: gpt4o,
  tools: { check_compliance: checkComplianceTool },
});

export async function executeComplianceAgent(input: ComplianceAgentInput): Promise<ComplianceResult> {
  return withSpan(OTEL_SPAN_NAMES.LLM_GPT4O_COMPLETION, {
    "lexguard.org_id": input.orgId, "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "compliance-agent", "compliance.jurisdiction": input.jurisdiction,
  }, async (span) => {
    const rulesCtx = input.jurisdictionRules.map((r) => JSON.stringify(r.payload).slice(0, 250)).join("\n");
    const docsCtx = input.regulatoryDocs.map((d) => JSON.stringify(d.payload).slice(0, 250)).join("\n");
    const r = (await checkComplianceTool.execute?.({ clauseType: input.clauseType, clauseIndex: input.clauseIndex, clauseText: input.clauseText, jurisdiction: input.jurisdiction, orgId: input.orgId, jurisdictionRulesContext: rulesCtx, regulatoryDocsContext: docsCtx }, {} as any)) as any || {};
    span.setAttribute("compliance.is_compliant", r.isCompliant);
    span.setAttribute("compliance.finding_count", Array.isArray(r.findings) ? r.findings.length : 0);
    span.setAttribute("llm.prompt_hash_sha256", r.promptHash);

    const safeFindings = Array.isArray(r.findings)
      ? r.findings.map((item: any) => ({
          regulation: item?.regulation ?? "Unknown",
          section: item?.section ?? "N/A",
          offendingLanguage: item?.offendingLanguage ?? "",
          requiredCorrection: item?.requiredCorrection ?? "Manual review required",
          severity: item?.severity ?? "Warning",
        }))
      : [];

    const blockingCount = safeFindings.filter((f: any) => f.severity === "Blocking").length;

    return {
      clauseIndex: input.clauseIndex,
      isCompliant: r.isCompliant ?? false,
      findings: safeFindings,
      jurisdictionVerified: r.jurisdictionVerified ?? false,
      requiresHitl: !(r.isCompliant ?? false) || !(r.jurisdictionVerified ?? false) || blockingCount > 0,
      complianceLatencyMs: r.latencyMs ?? 0,
      promptHash: r.promptHash,
    };
  });
}
