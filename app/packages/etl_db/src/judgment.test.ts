import { describe, expect, it } from "vitest";
import { isJudgment, judgmentTitle, shortParties } from "./judgment";

// parties as the courts' listings give them (kb.docs.meta, sampled 2026-11-17)
describe("shortParties", () => {
  it.each([
    ["Maddage Premalal  Vs. Hon. Attorney General", "Maddage Premalal v. Hon. Attorney General"],
    [
      "J. P. A. Jagath Keerthi v. Lalith U. Gamage, Governor Central Province and 28 others",
      "J. P. A. Jagath Keerthi v. Lalith U. Gamage",
    ],
    [
      "1. K.A. Gunawathi, Darshana Stores, Serukade, Chilaw 2. Balagage Susantha Kamal Nissanka Stores Defendants- Responden",
      "K.A. Gunawathi",
    ],
    [
      "Bothalayage Athula Sumanasekara Alawala, Thunthota. Plaintiff Vs 1. Mananalage Sumathipala 2. Dissanayake Ralalage",
      "Bothalayage Athula Sumanasekara Alawala v. Mananalage Sumathipala",
    ],
    [
      "1. P. Nirmala Priyangika Subasingha No. 266/C/1, Edanduwawa, Peradeniya. PETITIONER Vs. 1. P. G. Amarakoon Chairman. 2. W. M.",
      "P. Nirmala Priyangika Subasingha v. P. G. Amarakoon Chairman",
    ],
    [
      "A. W. T. P. Alagoda v.  Director – District General                           Hospital Matale and others",
      "A. W. T. P. Alagoda v. Director – District General Hospital Matale and others",
    ],
    [
      "Warnakula Patabandige Aquinas; Susantha Perera v. Officer-in Charge, Marawila and others",
      "Warnakula Patabandige Aquinas v. Officer-in Charge",
    ],
    [
      "F. A. Azeez 660/22, Main Street Matale Petitioner Vs. 1. H. M. Gunasekera Secretary, Ministry of Education",
      "F. A. Azeez v. H. M. Gunasekera Secretary",
    ],
    [
      "People’s Bank, No. 75, Chiththampalam A. Gardiner Mawatha, Colombo 02. PETITIONER-RESPONDENT –APPELLANT -Vs- 1. Witharana Gamage Siriwardane, Mulakanhena",
      "People’s Bank v. Witharana Gamage Siriwardane",
    ],
    [
      "1. Paranirupasingham Arulrajasingham, No. 22, Govt. Quarters. 1st Defendant-Respondent-Appellant Vs. 1. 2. Vadivelu Anandasiva. Vigneshwary",
      "Paranirupasingham Arulrajasingham v. Vadivelu Anandasiva. Vigneshwary",
    ],
    ["A. V. Perera v. The Attorney General", "A. V. Perera v. The Attorney General"],
    [
      "O.L.M. MACAN MARKAR LIMITED No: 26 Galle Face Vs. AL-HAMBRA HOTEL LIMITED",
      "O.L.M. MACAN MARKAR LIMITED v. AL-HAMBRA HOTEL LIMITED",
    ],
    [
      "Anton Norbet Laktansiv Kurera Vs. The Attorney General,",
      "Anton Norbet Laktansiv Kurera v. The Attorney General",
    ],
  ])("%s", (raw, want) => expect(shortParties(raw)).toBe(want));

  it("is null when the listing has none", () => expect(shortParties("  ")).toBeNull());
});

describe("judgmentTitle", () => {
  it("names parties, case and date", () =>
    expect(
      judgmentTitle({
        case: "CA/WRT/634/2021",
        date: "2025-12-12",
        parties: "J. P. A. Jagath Keerthi v. Lalith U. Gamage",
      }),
    ).toBe("J. P. A. Jagath Keerthi v. Lalith U. Gamage, CA/WRT/634/2021 (12.12.2025)"));
  it("keeps what it has", () => expect(judgmentTitle({ case: "SC/FR/6/2011" })).toBe("SC/FR/6/2011"));
  it("knows a judgment's key", () => {
    expect(isJudgment("ca:ca-writ-634-21-judgment-final")).toBe(true);
    expect(isJudgment("act:7/1972")).toBe(false);
    expect(isJudgment("cap:107")).toBe(false);
  });
});
