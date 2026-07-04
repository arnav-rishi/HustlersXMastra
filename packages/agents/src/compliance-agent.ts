/**
 * LexGuard AI — Compliance Agent (#9)
 * Checks clauses against jurisdiction_rules + regulatory_documents.
 * Conservative: flag if uncertain. GDPR/CCPA aware. Per PRD Appendix A.4
 */
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import OpenAI from "openai";
import { withSpan, OTEL_SPAN_NAMES } from "@lexguard/observability/tracer";
import { LLM_MODELS } from "@lexguard/shared/constants";
import { recordLlmTokens } from "@lexguard/observability/metrics";
import { getEnv } from "@lexguard/shared/env";
import type { RetrievedItem } from "@lexguard/shared/schemas";

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
  execute: async ({ context }) => {
    const env = getEnv();
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const prompt = `ROLE: Regulatory Compliance Specialist for ${context.jurisdiction}.
Check this ${context.clauseType} clause (index ${context.clauseIndex}) against jurisdiction rules.
RULES: ${context.jurisdictionRulesContext || "None retrieved — mark jurisdictionVerified=false."}
REGULATORY DOCS: ${context.regulatoryDocsContext || "None retrieved."}
RULES: Flag if uncertain. Cite specific regulation+section. GDPR: flag data processing without DPA. CCPA: flag California data without opt-out.
CLAUSE: ${context.clauseText.slice(0, 800)}
Return JSON: {"isCompliant":bool,"jurisdictionVerified":bool,"findings":[{"regulation":"...","section":"...","offendingLanguage":"...","requiredCorrection":"...","severity":"Blocking|Warning|Advisory"}]}`;
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    const start = Date.now();
    let result: any = null; let inputTokens = 0, outputTokens = 0;
    try {
      const response = await openai.chat.completions.create({
        model: LLM_MODELS.GPT4O, temperature: 0, response_format: { type: "json_object" },
        messages: [{ role: "system", content: prompt }, { role: "user", content: "Check compliance now." }],
      });
      inputTokens = response.usage?.prompt_tokens ?? 0;
      outputTokens = response.usage?.completion_tokens ?? 0;
      result = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      recordLlmTokens(context.orgId, LLM_MODELS.GPT4O, inputTokens, outputTokens);
    } catch {
      result = { isCompliant: false, jurisdictionVerified: false, findings: [{ regulation: "Unknown", section: "N/A", offendingLanguage: context.clauseText.slice(0, 80), requiredCorrection: "Manual review required", severity: "Warning" }] };
    }
    return { isCompliant: result.isCompliant ?? false, jurisdictionVerified: result.jurisdictionVerified ?? false, findings: result.findings ?? [], promptHash, inputTokens, outputTokens, latencyMs: Date.now() - start };
  },
});

export const complianceAgent = new Agent({
  name: "compliance-agent",
  instructions: "Check legal clauses for compliance using check_compliance. Flag if uncertain. Cite specific regulation+section. GDPR/CCPA aware. Escalate to HITL if jurisdictionVerified=false.",
  model: { provider: "OPEN_AI", name: "gpt-4o", toolChoice: "required" },
  tools: { check_compliance: checkComplianceTool },
});

export async function executeComplianceAgent(input: ComplianceAgentInput): Promise<ComplianceResult> {
  return withSpan(OTEL_SPAN_NAMES.LLM_GPT4O_COMPLETION, {
    "lexguard.org_id": input.orgId, "lexguard.contract_id": input.contractId,
    "lexguard.agent_id": "compliance-agent", "compliance.jurisdiction": input.jurisdiction,
  }, async (span) => {
    const rulesCtx = input.jurisdictionRules.map((r) => JSON.stringify(r.payload).slice(0, 250)).join("\n");
    const docsCtx = input.regulatoryDocs.map((d) => JSON.stringify(d.payload).slice(0, 250)).join("\n");
    const r = await checkComplianceTool.execute({ context: { clauseType: input.clauseType, clauseIndex: input.clauseIndex, clauseText: input.clauseText, jurisdiction: input.jurisdiction, orgId: input.orgId, jurisdictionRulesContext: rulesCtx, regulatoryDocsContext: docsCtx } } as any);
    span.setAttribute("compliance.is_compliant", r.isCompliant);
    span.setAttribute("compliance.finding_count", r.findings.length);
    span.setAttribute("llm.prompt_hash_sha256", r.promptHash);
    const blockingCount = r.findings.filter((f: any) => f.severity === "Blocking").length;
    return { clauseIndex: input.clauseIndex, isCompliant: r.isCompliant, findings: r.findings, jurisdictionVerified: r.jurisdictionVerified, requiresHitl: !r.isCompliant || !r.jurisdictionVerified || blockingCount > 0, complianceLatencyMs: r.latencyMs, promptHash: r.promptHash };
  });
}
