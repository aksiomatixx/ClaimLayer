# Regulatory Source Documents

Authoritative source documents for California workers' compensation
regulatory data used by HomeCare TPA.

## deu_table1_pv_pd.csv

DEU Present Value of Permanent Disability table (Table 1).
- **Source:** https://www.dir.ca.gov/t8/10169/table1.pdf
- **Fetched:** 2026-04-17
- **Authority:** 8 CCR §10169, §10169.1
- **Discount rate:** 3% annual (embedded)
- **Range:** weeks 1 through 950
- **Format:** CSV, two columns (weeks, pv)
- **Verified:** PV(322)=294.1718 and PV(240)=224.2725 match
  worked examples published in the CCR Commutation Procedures
  document.
- **Used by:** `commutationService.js` (M14.5)

## deu_commutation_templates_2001.zip

DEU's official Excel templates (A-G) mechanizing commutation
calculations, plus RTF instructions.
- **Source:** https://www.dir.ca.gov/dwc/ForumDocs/2021/DEU/Communtation-Table.docx
  (packaged zip, reachable via DWC DEU page)
- **Fetched:** 2026-04-17
- **Authority:** 8 CCR §10169 (2001 issuance, July 2001 amendment)
- **Used by:** `commutationService.js` (M14.5)

## wcis_edi_guide_v3.1.pdf

California EDI Implementation Guide for First and Subsequent Reports
of Injury (FROI/SROI), Release 1 Version 3.1.
- **Source:** https://www.dir.ca.gov/dwc/dwcpropregs/wcis-regulations/Final-Regulations/Guides/FROISROICAImplementationGuide-Final.pdf
- **Fetched:** 2026-04-18
- **Authority:** 8 CCR §§9700-9704; LC §§138.6, 138.7, 6409.1; 8 CCR §14001
- **Published:** March 27, 2018 by CA Division of Workers' Compensation
- **Version:** v3.1 (verify currency before M22B / AN build — check
  https://www.dir.ca.gov/dwc/WCIS.htm for revised guide)
- **Format:** 122-page PDF, authoritative spec for FROI, SROI, and AN
  transaction format, data element requirements, CA-specific edits,
  transaction sequencing, and WCIS matching rules.
- **Used by:** M22 (WCIS EDI FROI/SROI) — `wcisPayloadService.js`,
  `wcisTransmissionService.js`

### Code lists extracted from this guide

M22 extracts specific code lists from Section N of the guide into
separate CSVs as each transaction type requires them. These CSVs must
be kept in sync with the guide — regenerate when the guide is updated.

- `wcis_dn35_nature_of_injury.csv` — Nature of Injury codes (M22 initial)
- `wcis_dn36_body_part.csv` — Part of Body codes (M22 initial)
- `wcis_dn37_cause_of_injury.csv` — Cause of Injury codes (M22 initial)
- `wcis_dn85_payment_adjustment.csv` — Payment/Adjustment codes (M22 initial)
- `wcis_dn73_claim_status.csv` — Claim Status codes (M22 initial)
- Additional DN code lists as future milestones require them (DN77 Late
  Reason, DN59 Class, DN25 Industry/NAICS, DN95 Paid-to-Date)

## Update policy

Authoritative regulatory data in this folder may be revised by the
publishing authority (DWC, DEU, or other CA agencies). Any update
requires:

1. New file fetched from official source with date suffix in filename
   (e.g., `wcis_edi_guide_v3.2.pdf` alongside existing `wcis_edi_guide_v3.1.pdf`)
2. Regenerated CSV(s) committed alongside the old version(s)
3. Consuming service code updated with effective-date branching
   (claims with DOI before cutoff use old data; DOI on/after cutoff
   use new data)
4. Master Context Deferred Tasks entry noting the change
5. Unit test coverage for the branching logic before the old file is
   considered deprecated

**Never overwrite an old regulatory file in place.** Claims with DOI
before a regulatory change remain subject to the regulations in effect
at the DOI. Retain every version that was ever in force.
