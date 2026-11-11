// What a case file can be, and the fields read for the types a litigator works from most (docs/features/file-types).
// The other types get the generic card only.

export const DOC_TYPES = [
  "plaint",
  "answer",
  "replication",
  "petition",
  "objections",
  "affidavit",
  "counter_affidavit",
  "motion",
  "written_submissions",
  "appeal",
  "judgment",
  "order",
  "decree",
  "journal_entry",
  "indictment",
  "charge_sheet",
  "statement",
  "evidence",
  "expert_report",
  "medical_report",
  "police_report",
  "contract",
  "agreement",
  "lease",
  "deed",
  "will",
  "power_of_attorney",
  "letter",
  "notice",
  "letter_of_demand",
  "email",
  "invoice",
  "receipt",
  "identity_document",
  "certificate",
  "gazette",
  "legislation",
  "form",
  "notes",
  "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

/** What tells a type apart, for the classifier; null where the name says it. */
export const DOC_TYPE_HINTS: Record<DocType, string | null> = {
  plaint: "a civil action's opening pleading: the plaintiff's claim and the reliefs prayed for",
  answer: "the defendant's pleading in reply to a plaint: admissions, denials, a claim in reconvention",
  replication: "the plaintiff's reply to the answer",
  petition: "a petition to a court (writ, fundamental rights, revision, testamentary, divorce ...)",
  objections: "statement of objections to a petition or application",
  affidavit: "a sworn or affirmed statement of facts by a deponent",
  counter_affidavit: "an affidavit filed in reply to another party's affidavit",
  motion: "a motion filed in court asking for a step or an order",
  written_submissions: "a party's written arguments on the facts and the law",
  appeal: "a petition of appeal or notice of appeal",
  judgment: "a court's judgment deciding a case, with reasons",
  order: "a court's order on an application or a step, shorter than a judgment",
  decree: "the formal decree drawn up on a judgment",
  journal_entry: "the court's journal (case record) entries: what happened on a date and the next date",
  indictment: "an indictment by the Attorney General in the High Court",
  charge_sheet: "a charge sheet or plaint in a Magistrate's Court criminal case: offences, sections, accused",
  statement: "a statement recorded by the police or another officer",
  evidence: "a record of evidence or proceedings (testimony)",
  expert_report: null,
  medical_report: "a medico-legal or medical report",
  police_report: "a police report or B report to court",
  contract: null,
  agreement: null,
  lease: "a lease or tenancy agreement or deed of lease",
  deed: "a notarial deed of transfer, gift, mortgage or the like",
  will: "a last will",
  power_of_attorney: null,
  letter: "an ordinary letter",
  notice: "a notice (to quit, of a meeting, a legal notice that is not a demand for money)",
  letter_of_demand: "a lawyer's letter demanding payment or action by a deadline",
  email: null,
  invoice: null,
  receipt: null,
  identity_document: "a national identity card, passport, birth or marriage certificate",
  certificate: "a certificate other than an identity document",
  gazette: "a Government Gazette notification",
  legislation: "an Act, Ordinance or regulation",
  form: "a blank or filled printed form",
  notes: "a lawyer's or client's own notes",
  other: "none of these",
};

export type FieldKind = "text" | "list";
export type FieldSpec = { key: string; label: string; kind: FieldKind; hint: string };

const plaint: FieldSpec[] = [
  { key: "reliefs", label: "Reliefs prayed for", kind: "list", hint: "each relief in the prayer, in order" },
  { key: "causeOfAction", label: "Cause of action", kind: "text", hint: "in English, one or two sentences" },
  { key: "value", label: "Value of the action", kind: "text", hint: "as written, e.g. 'Rs. 2,500,000'" },
];
const answer: FieldSpec[] = [
  { key: "admissions", label: "Admissions", kind: "list", hint: "what the defendant admits, by paragraph if given" },
  { key: "denials", label: "Denials", kind: "list", hint: "what the defendant denies" },
  {
    key: "claimInReconvention",
    label: "Claim in reconvention",
    kind: "text",
    hint: "the defendant's own claim, if any",
  },
];
const affidavit: FieldSpec[] = [
  { key: "deponent", label: "Deponent", kind: "text", hint: "who swears or affirms it, as written" },
  { key: "averments", label: "Averments", kind: "list", hint: "the main facts sworn to, one each, in English" },
  {
    key: "markedDocuments",
    label: "Marked documents",
    kind: "list",
    hint: "documents annexed, with their marks, e.g. 'P1 - deed No. 1234'",
  },
];
const journal: FieldSpec[] = [
  { key: "entryDate", label: "Date", kind: "text", hint: "the date of the entry or order, YYYY-MM-DD" },
  { key: "whatHappened", label: "What happened", kind: "text", hint: "in English" },
  { key: "nextDate", label: "Next date", kind: "text", hint: "YYYY-MM-DD" },
  { key: "nextPurpose", label: "Next date for", kind: "text", hint: "trial, answer, further trial, order ..." },
];
const judgment: FieldSpec[] = [
  { key: "holding", label: "Holding", kind: "text", hint: "what the court decided, in English" },
  { key: "orders", label: "Orders", kind: "list", hint: "each order made" },
  { key: "authorities", label: "Authorities", kind: "list", hint: "cases and statutes relied on, as written" },
];
const deed: FieldSpec[] = [
  { key: "deedNumber", label: "Deed No.", kind: "text", hint: "as written" },
  { key: "notary", label: "Notary", kind: "text", hint: "the attesting notary" },
  { key: "land", label: "Land", kind: "text", hint: "lot, plan number and date, extent, as written" },
  { key: "consideration", label: "Consideration or rent", kind: "text", hint: "the price or rent, as written" },
  { key: "term", label: "Term", kind: "text", hint: "the lease period, if any" },
];
const demand: FieldSpec[] = [
  { key: "demandedFrom", label: "Demanded from", kind: "text", hint: "who must pay or act" },
  { key: "amount", label: "Amount", kind: "text", hint: "as written" },
  { key: "deadline", label: "Deadline", kind: "text", hint: "YYYY-MM-DD, or as written ('within 14 days')" },
];
const charges: FieldSpec[] = [
  { key: "accused", label: "Accused", kind: "list", hint: "each accused, as written" },
  { key: "offences", label: "Offences", kind: "list", hint: "each charge, in English" },
  { key: "sections", label: "Sections", kind: "list", hint: "the sections charged under, as written" },
];

/** The type-specific fields; a type not here has none. */
export const FIELDS: Partial<Record<DocType, FieldSpec[]>> = {
  plaint,
  answer,
  affidavit,
  journal_entry: journal,
  order: journal,
  judgment,
  deed,
  lease: deed,
  letter_of_demand: demand,
  charge_sheet: charges,
};
