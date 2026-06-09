// ═══════════════════════════════════════════════════════════
// MOCK / DEMO DATA (extracted verbatim from App.jsx)
// ═══════════════════════════════════════════════════════════
export const ADP_EMP={
  "BC-001":{legalName:"Maria Santos",dob:"03/15/1981",address:"1842 W 7th St",city:"Los Angeles",state:"CA",zip:"90057",phone:"(213) 555-0142",jobTitle:"Home Health Aide II",aww:750.75,tdRate:500.50},
  "CF-014":{legalName:"James Okonkwo",dob:"07/22/1975",address:"4320 Crenshaw Blvd Apt 8",city:"Los Angeles",state:"CA",zip:"90008",phone:"(323) 555-0198",jobTitle:"LVN Home Health",aww:1120.00,tdRate:746.67},
  "SR-022":{legalName:"Lupe Hernandez",dob:"11/08/1990",address:"7715 Sepulveda Blvd",city:"Van Nuys",state:"CA",zip:"91405",phone:"(818) 555-0077",jobTitle:"Personal Care Worker",aww:621.00,tdRate:414.00},
};

export const MPN_PROVIDERS=[
  {id:"c1",name:"Concentra Urgent Care",branch:"Mid-Wilshire",addr:"3699 Wilshire Blvd",city:"Los Angeles",zip:"90010",phone:"(213) 637-0500",specialty:"Occupational Medicine",rating:4.2,reviews:142,walkIn:true,zips:["900","901","902"]},
  {id:"c2",name:"Concentra Urgent Care",branch:"Van Nuys",addr:"14510 Lankershim Blvd",city:"Van Nuys",zip:"91402",phone:"(818) 781-3600",specialty:"Occupational Medicine",rating:4.1,reviews:98,walkIn:true,zips:["914","913","915","912"]},
  {id:"k1",name:"Kaiser Occ Health",branch:"West LA",addr:"6041 Cadillac Ave",city:"Los Angeles",zip:"90034",phone:"(310) 297-3456",specialty:"Occupational Medicine",rating:4.5,reviews:210,walkIn:false,zips:["900","902","903","904"]},
  {id:"s1",name:"SoCal Ortho & Sports",branch:"Koreatown",addr:"3650 W 6th St Ste 400",city:"Los Angeles",zip:"90020",phone:"(213) 383-9898",specialty:"Orthopedic Surgery",rating:4.6,reviews:87,walkIn:false,zips:["900","901"]},
  {id:"u1",name:"UCLA Occ Health Clinic",branch:"Westwood",addr:"10833 Le Conte Ave",city:"Los Angeles",zip:"90095",phone:"(310) 825-6301",specialty:"Occupational Medicine",rating:4.7,reviews:312,walkIn:false,zips:["900","905","906"]},
  {id:"v1",name:"Valley Occ Med Center",branch:"Van Nuys",addr:"15415 Vanowen St",city:"Van Nuys",zip:"91405",phone:"(818) 780-0860",specialty:"Occupational Medicine",rating:3.9,reviews:44,walkIn:true,zips:["914","913"]},
  {id:"p1",name:"PIH Health Urgent Care",branch:"Whittier",addr:"12401 Washington Blvd",city:"Whittier",zip:"90602",phone:"(562) 698-0811",specialty:"Occupational Medicine",rating:4.3,reviews:155,walkIn:true,zips:["906","907","908"]},
  {id:"e1",name:"Employee Health Services",branch:"Downtown LA",addr:"1200 N State St",city:"Los Angeles",zip:"90033",phone:"(323) 226-4000",specialty:"Occupational & Infectious Disease",rating:4.4,reviews:66,walkIn:true,zips:["900","901","902","903"]},
];

export const NOTICE_TYPES=[
  {id:"dwc7",label:"DWC-7 — Notice of Representation",trigger:"On acceptance",urgency:"Within 5 days"},
  {id:"delay",label:"Delay Notice — Claim Not Resolved",trigger:"Day 14 if no decision",urgency:"By Day 14"},
  {id:"td",label:"TD Benefit Notice — Indemnity Started",trigger:"First TD payment",urgency:"With first check"},
  {id:"denial",label:"Denial Letter — Claim Denied",trigger:"On denial",urgency:"Within 90 days"},
  {id:"rtw",label:"RTW Offer — Return to Work",trigger:"MMI reached",urgency:"Within 30 days of MMI"},
  {id:"dwc9",label:"DWC-9 — Notice of Payments",trigger:"Each payment",urgency:"With each payment"},
];

// INIT_CLAIMS removed in M3 — admin dashboard uses live backend data via React Query

export const EMPLOYERS=["BrightCare Home Health","ComfortFirst Healthcare","SunRise Home Care","CareWell Services","HomeHope Inc."];
export const BODY_PARTS=["Lumbar Spine / Lower Back","Cervical Spine / Neck","Shoulder","Knee","Wrist / Hand","Ankle / Foot","Hip","Multiple Body Parts","Other"];
export const INJURY_TYPES=["Strain / Sprain","Lifting Injury","Slip & Fall","Needlestick / Sharps","Contusion","Laceration","Fracture","Repetitive Motion","Motor Vehicle","Other"];
