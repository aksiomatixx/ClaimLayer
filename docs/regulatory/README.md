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

## deu_commutation_templates_2001.zip

DEU's official Excel templates (A-G) mechanizing commutation
calculations, plus RTF instructions.
- **Source:** https://www.dir.ca.gov/dwc/ForumDocs/2021/DEU/Communtation-Table.docx
  (packaged zip, reachable via DWC DEU page)
- **Fetched:** 2026-04-17
- **Authority:** 8 CCR §10169 (2001 issuance, July 2001 amendment)
- **Used by:** `commutationService.js` (M14.5)

## Update policy

DEU may revise these tables. Any update requires:
1. New file fetched from dir.ca.gov with date in filename
2. New CSV generated, committed alongside old one
3. `commutationService.js` updated with effective-date branching
4. Master Context Deferred Tasks entry noting the change
