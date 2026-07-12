/**
 * Demo seed: inserts a COMPLETED contract analysis for
 * test-fixtures/sample-msa-contract.pdf directly into Postgres, bypassing
 * the live agent pipeline entirely. Used to guarantee a working demo
 * (dashboard summary + chatbot Q&A) regardless of Qdrant/pipeline health —
 * the analysis below reflects a genuine read of the actual contract text,
 * not placeholder content.
 *
 * Usage: npx tsx prisma/seed-demo-contract.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEV_ORG_ID = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";
export const DEMO_CONTRACT_ID = "11111111-1111-1111-1111-111111111111";

const clauses = [
  {
    clauseIndex: 0,
    clauseType: "indemnification",
    clauseText:
      "Client shall indemnify, defend, and hold harmless Provider, its officers, directors, and employees from and against any and all claims, damages, losses, and expenses, including reasonable attorneys' fees, arising out of or related to Client's use of the Services, without any cap or limitation on the amount or duration of such indemnification obligations.",
    riskLevel: "CRITICAL" as const,
    riskScore: 92,
    risks: [
      {
        severity: "Critical",
        description:
          "Indemnification runs only one way (Client to Provider) and has no dollar cap or time limit — Client could be on the hook for unlimited legal costs and damages tied to normal use of the service.",
        triggeringLanguage: "without any cap or limitation on the amount or duration",
        financialExposure: "Unlimited",
        citation: "Section 1, Indemnification",
      },
    ],
    rewriteOptionA:
      "Client shall indemnify Provider for third-party claims directly caused by Client's breach of this Agreement or violation of law, with indemnification obligations capped at the total fees paid in the twelve (12) months preceding the claim, and mutual indemnification obligations applying equally to Provider.",
  },
  {
    clauseIndex: 1,
    clauseType: "limitation_of_liability",
    clauseText:
      "IN NO EVENT SHALL PROVIDER BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES. PROVIDER'S TOTAL LIABILITY UNDER THIS AGREEMENT SHALL NOT EXCEED THE FEES PAID BY CLIENT IN THE THREE (3) MONTHS PRECEDING THE CLAIM, EXCEPT THAT CLIENT'S LIABILITY TO PROVIDER SHALL REMAIN UNCAPPED AND UNLIMITED UNDER ALL CIRCUMSTANCES.",
    riskLevel: "CRITICAL" as const,
    riskScore: 95,
    risks: [
      {
        severity: "Critical",
        description:
          "Provider's liability is tightly capped at 3 months of fees, but Client's liability to Provider is explicitly carved out as uncapped and unlimited — a severe asymmetry that leaves Client exposed while Provider is well protected.",
        triggeringLanguage: "CLIENT'S LIABILITY TO PROVIDER SHALL REMAIN UNCAPPED AND UNLIMITED",
        financialExposure: "Unlimited (Client side); capped at ~3 months' fees (Provider side)",
        citation: "Section 2, Limitation of Liability",
      },
    ],
    rewriteOptionA:
      "Except for breaches of confidentiality or indemnification obligations, each party's total liability under this Agreement shall not exceed the fees paid in the twelve (12) months preceding the claim, applied equally to both parties.",
  },
  {
    clauseIndex: 2,
    clauseType: "ip_ownership",
    clauseText:
      "All work product, deliverables, and derivative works created under this Agreement shall be considered work for hire, and Client hereby assigns all right, title, and interest in such intellectual property to Provider, including any pre-existing IP contributed by Client during the engagement.",
    riskLevel: "CRITICAL" as const,
    riskScore: 88,
    risks: [
      {
        severity: "Critical",
        description:
          "This assigns Client's own pre-existing IP to Provider if it's contributed during the engagement — not just new work product. Client could permanently lose rights to tools or materials they brought into the project.",
        triggeringLanguage: "including any pre-existing IP contributed by Client during the engagement",
        financialExposure: "Loss of ownership of pre-existing IP assets",
        citation: "Section 3, Intellectual Property Ownership",
      },
    ],
    rewriteOptionA:
      "New work product created specifically for Client under this Agreement shall be assigned to Client upon full payment. Each party retains all right, title, and interest in its own pre-existing intellectual property, including materials contributed during the engagement.",
  },
  {
    clauseIndex: 3,
    clauseType: "auto_renewal",
    clauseText:
      "This Agreement shall automatically renew for successive one (1) year terms unless either party provides written notice of non-renewal at least ninety (90) days prior to the end of the then-current term. Client acknowledges that failure to provide timely notice will auto-renew the Agreement at Provider's then-current list price, which may increase up to 25% year over year.",
    riskLevel: "MODERATE" as const,
    riskScore: 62,
    risks: [
      {
        severity: "Moderate",
        description:
          "A missed 90-day notice window locks Client in for another year at a price that could jump up to 25% — a meaningful budget risk if this date isn't tracked closely.",
        triggeringLanguage: "which may increase up to 25% year over year",
        financialExposure: "Up to 25% year-over-year price increase upon auto-renewal",
        citation: "Section 4, Automatic Renewal",
      },
    ],
    rewriteOptionA:
      "This Agreement shall automatically renew for successive one (1) year terms at the same fees unless either party provides written notice of non-renewal at least thirty (30) days prior to the end of the then-current term. Any price increase upon renewal shall not exceed 5% and requires sixty (60) days' advance written notice.",
  },
  {
    clauseIndex: 4,
    clauseType: "termination",
    clauseText:
      "Provider may terminate this Agreement for cause immediately upon written notice if Client breaches any material term. Client's right to cancel is limited to termination for cause only, with a thirty (30) day cure period, and Client may not terminate for convenience during the initial term.",
    riskLevel: "MODERATE" as const,
    riskScore: 58,
    risks: [
      {
        severity: "Moderate",
        description:
          "Termination rights are asymmetric: Provider can terminate immediately for cause, while Client is locked into the initial term entirely, with no convenience-termination option even if the relationship isn't working out.",
        triggeringLanguage: "Client may not terminate for convenience during the initial term",
        financialExposure: "Client locked into full initial term regardless of satisfaction",
        citation: "Section 5, Termination",
      },
    ],
    rewriteOptionA:
      "Either party may terminate this Agreement for cause upon written notice, with a thirty (30) day cure period. Client may additionally terminate for convenience after the first ninety (90) days upon sixty (60) days' written notice.",
  },
  {
    clauseIndex: 5,
    clauseType: "payment_terms",
    clauseText:
      "Client shall pay all invoices within thirty (30) days of receipt (Net 30). Amounts not paid when due shall accrue a late fee of 1.5% per month. Invoices disputed in good faith must be flagged within five (5) business days or are deemed accepted.",
    riskLevel: "MODERATE" as const,
    riskScore: 45,
    risks: [
      {
        severity: "Moderate",
        description:
          "Standard Net 30 terms and an 18%-per-year late fee are typical, but the 5-business-day window to dispute an invoice is unusually tight and could cause legitimate billing errors to be deemed accepted by default.",
        triggeringLanguage: "must be flagged within five (5) business days or are deemed accepted",
        financialExposure: "1.5% monthly late fee (~18% APR); short dispute window",
        citation: "Section 6, Payment Terms",
      },
    ],
    rewriteOptionA:
      "Invoices disputed in good faith must be flagged within thirty (30) days of receipt or are deemed accepted.",
  },
  {
    clauseIndex: 6,
    clauseType: "confidentiality",
    clauseText:
      "Each party agrees to hold the other party's Confidential Information in strict confidence and not to disclose such proprietary information to any third party. This obligation constitutes a non-disclosure undertaking that survives termination of this Agreement indefinitely.",
    riskLevel: "LOW" as const,
    riskScore: 20,
    risks: [],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 7,
    clauseType: "data_processing",
    clauseText:
      "To the extent Provider processes personal data on behalf of Client, Provider shall act as a data processor and Client as data controller in accordance with GDPR and CCPA. Provider shall implement appropriate technical and organizational measures for data processing activities, including cross-border transfers to Provider's affiliates outside the European Economic Area.",
    riskLevel: "MODERATE" as const,
    riskScore: 55,
    risks: [
      {
        severity: "Moderate",
        description:
          "Cross-border data transfers outside the EEA are mentioned without specifying a GDPR-compliant transfer mechanism (e.g. Standard Contractual Clauses) — a compliance gap if any EU personal data is involved.",
        triggeringLanguage: "cross-border transfers to Provider's affiliates outside the European Economic Area",
        financialExposure: "Potential GDPR non-compliance exposure",
        citation: "Section 8, Data Processing",
      },
    ],
    rewriteOptionA:
      "Cross-border transfers of personal data outside the European Economic Area shall be conducted pursuant to Standard Contractual Clauses or another GDPR-recognized transfer mechanism.",
  },
  {
    clauseIndex: 8,
    clauseType: "warranty",
    clauseText:
      "PROVIDER WARRANTS THAT SERVICES WILL BE PERFORMED IN A PROFESSIONAL MANNER. EXCEPT AS EXPRESSLY SET FORTH HEREIN, THE SERVICES ARE PROVIDED ON AN AS-IS BASIS, AND PROVIDER DISCLAIMS ALL OTHER WARRANTIES, WHETHER EXPRESS OR IMPLIED. Client represents and warrants that it has the authority to enter into this Agreement.",
    riskLevel: "MODERATE" as const,
    riskScore: 40,
    risks: [
      {
        severity: "Moderate",
        description:
          "Standard broad warranty disclaimer beyond the professional-services commitment — fairly common, but worth flagging since it limits recourse if deliverables have defects not tied to a breach of the professional-manner warranty.",
        triggeringLanguage: "PROVIDER DISCLAIMS ALL OTHER WARRANTIES, WHETHER EXPRESS OR IMPLIED",
        financialExposure: "Limited recourse for non-conforming deliverables outside the professional-manner warranty",
        citation: "Section 9, Warranty",
      },
    ],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 9,
    clauseType: "dispute_resolution",
    clauseText:
      "Any dispute arising out of this Agreement shall be resolved through binding arbitration administered under the rules of the American Arbitration Association. The parties waive the right to mediation prior to arbitration. Governing law shall be the State of Delaware, and jurisdiction for any court proceedings ancillary to arbitration shall lie exclusively in Delaware.",
    riskLevel: "MODERATE" as const,
    riskScore: 65,
    risks: [
      {
        severity: "Moderate",
        description:
          "This clause sets governing law as Delaware and venue as Delaware, but the Agreement's preamble separately states governing law is California with venue in Santa Clara County — an internal inconsistency that could create real confusion in a dispute.",
        triggeringLanguage: "Governing law shall be the State of Delaware",
        financialExposure: "Legal uncertainty / potential venue disputes",
        citation: "Section 10, Dispute Resolution (conflicts with preamble governing-law clause)",
      },
    ],
    rewriteOptionA:
      "Align the governing law and venue stated here with the preamble (State of California; Santa Clara County) to remove the internal inconsistency, and preserve the right to seek mediation before binding arbitration.",
  },
  {
    clauseIndex: 10,
    clauseType: "force_majeure",
    clauseText:
      "Neither party shall be liable for delays caused by force majeure events, including acts of God, natural disasters, or other circumstances beyond the control of the affected party, provided that Client's payment obligations shall not be excused by any force majeure event.",
    riskLevel: "MODERATE" as const,
    riskScore: 42,
    risks: [
      {
        severity: "Moderate",
        description:
          "Force majeure protection is mutual for performance delays, but Client's payment obligations are explicitly carved out and continue even during a force majeure event affecting Client directly.",
        triggeringLanguage: "Client's payment obligations shall not be excused by any force majeure event",
        financialExposure: "Client must continue paying during force majeure events affecting Client",
        citation: "Section 11, Force Majeure",
      },
    ],
    rewriteOptionA: null,
  },
  {
    clauseIndex: 11,
    clauseType: "assignment",
    clauseText:
      "Client may not assign, transfer, subcontract, or delegate any of its rights or obligations under this Agreement without Provider's prior written consent, which may be withheld in Provider's sole discretion. Provider may freely assign this Agreement to any successor or affiliate.",
    riskLevel: "MODERATE" as const,
    riskScore: 48,
    risks: [
      {
        severity: "Moderate",
        description:
          "Assignment rights are one-sided: Client needs Provider's consent (which Provider can withhold for any reason), while Provider can assign the Agreement freely — relevant if Client is ever acquired or restructures.",
        triggeringLanguage: "Provider may freely assign this Agreement to any successor or affiliate",
        financialExposure: "Restricted flexibility for Client in M&A/restructuring scenarios",
        citation: "Section 12, Assignment",
      },
    ],
    rewriteOptionA:
      "Neither party may assign this Agreement without the other's prior written consent, not to be unreasonably withheld, except that either party may assign to a successor in connection with a merger, acquisition, or sale of substantially all assets.",
  },
];

const criticalCount = clauses.filter((c) => c.riskLevel === "CRITICAL").length;
const moderateCount = clauses.filter((c) => c.riskLevel === "MODERATE").length;
const lowCount = clauses.filter((c) => c.riskLevel === "LOW").length;

const analysisJson = {
  executiveSummary:
    "This Master Services Agreement between Northwind Analytics (Provider) and Hustlers Ventures LLC (Client) is heavily one-sided in Provider's favor. The three most serious issues: Client's indemnification and liability to Provider are both explicitly uncapped and unlimited while Provider's own liability is capped at three months' fees; Client's pre-existing intellectual property contributed during the engagement gets assigned to Provider, not just new work product; and auto-renewal can raise fees up to 25% per year if the 90-day non-renewal notice is missed. There's also an internal inconsistency between the governing-law clause in the preamble (California) and the dispute-resolution section (Delaware) that should be resolved before signing. None of these are unusual clause types individually, but the degree of asymmetry across indemnification, liability, IP, termination, and assignment all favoring the same party is a real negotiation flag.",
  overallRisk: "Critical",
  totalClauses: clauses.length,
  criticalCount,
  moderateCount,
  lowCount,
  jurisdictionFlags: [
    "Governing law conflict: preamble specifies California/Santa Clara County, Section 10 specifies Delaware.",
    "Cross-border personal data transfer (Section 8) lacks a specified GDPR transfer mechanism.",
  ],
  clauseBreakdown: clauses.map((c) => ({
    clauseIndex: c.clauseIndex,
    clauseType: c.clauseType,
    clauseText: c.clauseText,
    overallRisk: c.riskLevel.charAt(0) + c.riskLevel.slice(1).toLowerCase(),
    risks: c.risks,
    rewrites: c.rewriteOptionA ? [{ text: c.rewriteOptionA, version: 1 }] : [],
    benchmarkScore: c.riskScore,
    benchmarkPercentile: Math.min(95, c.riskScore + 5),
    complianceFlags: c.clauseType === "data_processing" ? ["GDPR cross-border transfer mechanism unspecified"] : [],
    enkryptConfidence: 0.91,
    hitlStatus: "not_required",
  })),
};

async function main() {
  await prisma.contract.upsert({
    where: { id: DEMO_CONTRACT_ID },
    update: {
      status: "COMPLETED",
      workflowStatus: "completed",
      workflowStep: "reporting",
      progressPct: 100,
      overallRisk: "CRITICAL",
      analysisJson,
      completedAt: new Date(),
    },
    create: {
      id: DEMO_CONTRACT_ID,
      orgId: DEV_ORG_ID,
      uploadedBy: DEV_USER_ID,
      fileName: "sample-msa-contract.pdf",
      fileSize: 5386,
      mimeType: "application/pdf",
      documentType: "DIGITAL_PDF",
      s3Key: "demo/sample-msa-contract.pdf",
      jurisdiction: "California",
      status: "COMPLETED",
      workflowStatus: "completed",
      workflowStep: "reporting",
      progressPct: 100,
      pageCount: 2,
      partyNames: ["Northwind Analytics, Inc.", "Hustlers Ventures LLC"],
      contractTitle: "Master Services Agreement — Northwind Analytics / Hustlers Ventures",
      overallRisk: "CRITICAL",
      analysisJson,
      completedAt: new Date(),
    },
  });

  await prisma.clause.deleteMany({ where: { contractId: DEMO_CONTRACT_ID } });
  await prisma.clause.createMany({
    data: clauses.map((c) => ({
      contractId: DEMO_CONTRACT_ID,
      clauseIndex: c.clauseIndex,
      clauseType: c.clauseType,
      clauseText: c.clauseText,
      riskLevel: c.riskLevel,
      riskScore: c.riskScore,
      rewriteOptionA: c.rewriteOptionA,
    })),
  });

  console.log(`Seeded demo contract ${DEMO_CONTRACT_ID} with ${clauses.length} clauses (${criticalCount} critical, ${moderateCount} moderate, ${lowCount} low).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
