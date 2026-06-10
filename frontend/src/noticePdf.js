// Notice PDF generation via jsPDF (loaded globally as window.jspdf)

import EmployeeIntakeWizard from './components/EmployeeIntakeWizard.jsx';
import { fmt$ } from './utils.js';

export function generateNoticePDF(claim,noticeType){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:"portrait",unit:"mm",format:"letter"});
  const W=215.9,M=20; let y=M;
  doc.setFillColor(10,22,34); doc.rect(0,0,W,18,"F");
  doc.setFontSize(11);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  doc.text("HomeCare TPA — Workers' Compensation Notice",W/2,12,{align:"center"});
  y=26;
  doc.setFontSize(9);doc.setFont("helvetica","normal");doc.setTextColor(200,220,240);
  doc.text(`Date: ${new Date().toLocaleDateString()}`,M,y);
  doc.text(`Claim No: ${claim.id}`,W-M,y,{align:"right"}); y+=8;
  doc.text(`To: ${claim.claimant}`,M,y); y+=5;
  doc.text(claim.homeAddr||"Address on file",M,y); y+=10;
  doc.setFontSize(12);doc.setFont("helvetica","bold");doc.setTextColor(245,158,11);
  const TITLES={dwc7:"NOTICE OF REPRESENTATION — DWC-7",delay:"NOTICE OF DELAY IN CLAIM DETERMINATION",td:"NOTICE OF TEMPORARY DISABILITY BENEFIT PAYMENTS",denial:"NOTICE OF CLAIM DENIAL",rtw:"NOTICE OF RETURN-TO-WORK OFFER",dwc9:"NOTICE OF COMPENSATION PAYMENTS — DWC-9"};
  doc.text(TITLES[noticeType]||"NOTICE",W/2,y,{align:"center"}); y+=10;
  doc.setDrawColor(26,46,69);doc.line(M,y,W-M,y); y+=6;
  doc.setFontSize(9);doc.setFont("helvetica","normal");doc.setTextColor(216,232,245);
  const BODY={
    dwc7:`This letter is to inform you that HomeCare TPA, located at [TPA Address], has been authorized to act as administrator of your workers' compensation claim (${claim.id}) on behalf of ${claim.employer}. For questions, contact your assigned adjuster.`,
    delay:`Your claim (${claim.id}) for an injury on ${claim.dateOfInjury} has been received. We are unable to make a determination on your claim at this time. We will notify you of our decision within the time allowed by law. You continue to have the right to emergency medical treatment during this period.`,
    td:`You are entitled to Temporary Disability (TD) benefits for your work injury. Your average weekly wage is ${fmt$(claim.aww)}. Your TD rate is ${fmt$(claim.tdRate)} per week (2/3 of AWW per CA Labor Code §4453). Payments will begin on the next scheduled pay date.`,
    denial:`After investigation, your claim (${claim.id}) for an injury on ${claim.dateOfInjury} has been denied. If you disagree with this decision, you have the right to file an Application for Adjudication with the Workers' Compensation Appeals Board (WCAB). Contact DWC Information & Assistance: 1-800-736-7401.`,
    rtw:`This is a notice that a return-to-work position is available for you at ${claim.employer}. A modified/alternative duty position has been identified that accommodates your work restrictions. Please respond within 10 days.`,
    dwc9:`Enclosed please find a statement of compensation payments made on your behalf for claim ${claim.id}. Medical payments: ${fmt$(claim.aiAnalysis?.suggestedMedicalReserve||0)}. Indemnity payments: ${fmt$(claim.aiAnalysis?.suggestedIndemnityReserve||0)}.`,
  };
  const bl=doc.splitTextToSize(BODY[noticeType]||"",W-M*2);
  doc.text(bl,M,y); y+=bl.length*5+14;
  doc.setFontSize(8);doc.setTextColor(100,120,140);
  doc.text("_______________________________",M,y); y+=6;
  doc.text("Adjuster Signature / HomeCare TPA",M,y); y+=5;
  doc.text(`If you have questions, call (800) 555-0190 (HomeCare TPA) or DWC Info Line: 1-800-736-7401`,M,y+10,);
  doc.setFontSize(7);doc.setTextColor(60,80,100);
  doc.text(`${claim.id} | Mailed via USPS First Class | Lob.com print & mail service`,W/2,198,{align:"center"});
  return doc;
}

// EMPLOYEE INTAKE WIZARD moved to src/components/EmployeeIntakeWizard.jsx

// ═══════════════════════════════════════════════════════════
// RFA CENTER (Admin) — M7: RFA Decision Pipeline
// ═══════════════════════════════════════════════════════════
