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

Three of the seven M22A pre-build code lists are fully enumerated in
guide Section N. The other four delegate to external authoritative
sources; those CSVs ship as header-only stubs and are populated in a
follow-up once the source document is obtained.

- `wcis_dn77_late_reason.csv` — **Status:** EXTRACTED from guide §N
  pg 90. 23 codes: 10 Delays (L1-LA), 1 Coverage (C1), 6 Errors
  (E1-E6), 6 Disputes (D1-D6).
- `wcis_dn85_payment_adjustment.csv` — **Status:** EXTRACTED from
  guide §N pg 92. 26 codes: 16 active (7 standard + 9 compromised 5xx)
  + 10 deprecated (021, 040, 051, 080, 410, 521, 540, 541, 551, 580)
  per guide's "should NOT be sent on recent claims" note.
- `wcis_dn95_paid_to_date.csv` — **Status:** EXTRACTED from guide §N
  pg 92. 23 rows across three categories: 16 paid-to-date (300-460),
  2 reduced-earnings ranges (600-624, 650-674), 5 recoveries (800-840).
  Ranges preserved verbatim; `wcisPayloadService` expands at load time.
- `wcis_dn35_nature_of_injury.csv` — **Status:** STUB.
  **Authoritative source:** http://www.wcio.org/Document%20Library/InjuryDescriptionTablePage.aspx
  (WCIO InjuryDescriptionTable). Guide §N pg 90 delegates to this URL
  without enumerating code values.
- `wcis_dn36_body_part.csv` — **Status:** STUB.
  **Authoritative source:** same WCIO InjuryDescriptionTable URL.
  Shared between FROI DN36 and SROI DN83.
- `wcis_dn37_cause_of_injury.csv` — **Status:** STUB.
  **Authoritative source:** same WCIO InjuryDescriptionTable URL.
- `wcis_dn73_claim_status.csv` — **Status:** STUB.
  **Authoritative source:** IAIABC EDI Implementation Guide Release 1
  (paid document, http://www.iaiabc.org). Note: the CA-specific rule
  "DN73 must = C or X on FN" is extractable from guide Section L and
  IS enforced in `wcisPayloadService` regardless of whether the full
  code list is populated.

Code lists deferred entirely (not stubbed in pre-build):

- DN59 WCIRB Class Code — optional per guide for self-insured
  employers; ~500 codes at https://wcirbonline.org/wcirb/Answer_center/classification_information.html.
- DN25 NAICS Industry Code — employer-level field, ~1000 codes at
  U.S. Census Bureau http://www.census.gov/epcd/www/naics.html.

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

## Pending authoritative sources

The following regulatory data is required by M22 (WCIS EDI) but is
not yet committed. Main-build payload validation operates in
format-only mode for the affected DN fields until sources land.

### WCIO InjuryDescriptionTable (DN35, DN36, DN37)
- **Authority:** Workers Compensation Insurance Organizations (WCIO)
- **Source URL:** http://www.wcio.org/Document%20Library/InjuryDescriptionTablePage.aspx
- **Scope:** Nature of Injury codes, Part of Body codes, Cause of
  Injury codes. Single workbook covers all three.
- **Status:** PENDING acquisition. Acquire as Excel or PDF from WCIO
  site. Commit as wcio_injury_description_table_v{YYYY-MM-DD} plus
  three derived CSVs in a single commit.

### IAIABC Release 1 EDI Implementation Guide (DN73 and others)
- **Authority:** International Association of Industrial Accident
  Boards and Commissions
- **Source:** Paid document, requires IAIABC membership or per-copy
  purchase
- **Scope:** DN73 Claim Status full code list. Other IAIABC-standard
  data element definitions not enumerated in the CA guide.
- **Status:** PENDING purchase. When acquired, commit as
  iaiabc_edi_impl_guide_r1_v{version}.pdf with derived CSVs.

### WCIRB Class Codes (DN59)
- **Authority:** Workers' Compensation Insurance Rating Bureau of
  California
- **Source URL:** https://wcirbonline.org/wcirb/Answer_center/classification_information.html
- **Scope:** ~500 class codes for California.
- **Status:** DEFERRED. DN59 is optional per WCIS guide. Not blocking.

### Census NAICS industry codes (DN25)
- **Authority:** U.S. Census Bureau
- **Source:** census.gov/naics
- **Scope:** Employer-level industry classification.
- **Status:** DEFERRED. DN25 is employer-level, not per-claim.
  Low priority.
