/**
 * Pairing library.
 *
 * Each row answers: what does industry A have that industry B needs, and what
 * makes B act now? Organised by supplier sector.
 *
 * The selection principle, learned from the first twelve: the strongest
 * pairings are the ones where B faces an EXTERNALLY IMPOSED DEADLINE — a
 * licence renewal, a statutory audit, a lease handover, a launch date, a
 * festival. Those buy regardless of mood or budget cycle. Pairings driven only
 * by "it would be nice to have" are scored lower and marked as such.
 *
 * Scores are honest hypotheses, not research. `conf` is deliberately low across
 * the board; the Performance Agent re-ranks these from real outcomes once
 * conversion data exists.
 */

export type PairingSeed = {
  a: string; b: string; lane: "DIRECT" | "ADJACENT" | "SEASONAL" | "TRIGGER" | "CHANNEL" | "CONTRARIAN";
  has: string; needs: string; trigger: string; window?: string;
  reachA: string[]; reachB: string[];
  low: number; high: number; rate: number;
  demand: number; supply: number; comp: number; conf: number;
};

const p = (
  a: string, b: string, lane: PairingSeed["lane"],
  has: string, needs: string, trigger: string, window: string,
  reachA: string[], reachB: string[],
  low: number, high: number, rate: number,
  nums: [number, number, number, number],
): PairingSeed => ({
  a, b, lane, has, needs, trigger, window, reachA, reachB, low, high, rate,
  demand: nums[0], supply: nums[1], comp: nums[2], conf: nums[3],
});

const OWNER = ["Owner", "Managing Director"];
const BD = ["Business Development Manager", "Sales Director"];
const OPS = ["Operations Manager", "General Manager"];
const FM = ["Facilities Manager", "Building Manager"];
const HR = ["HR Manager", "Head of People"];
const FIN = ["Finance Manager", "Financial Controller"];
const MKT = ["Marketing Manager", "Marketing Director"];
const PROC = ["Procurement Manager", "Purchasing Manager"];
const FOUNDER = ["Founder", "Managing Director"];

export const PAIRINGS: PairingSeed[] = [
  // ───────────────────────── FACILITIES & BUILDING SERVICES ─────────────────
  p("Commercial laundry and linen services", "Boutique hotels, spas and restaurants", "DIRECT",
    "Industrial washing capacity, daily pickup routes, hygiene processes that pass inspection.",
    "Linen turned around daily without buying machines or hiring for it.",
    "A new outlet opening, a failed hygiene inspection, or peak season straining their current supplier.",
    "4–6 weeks before an outlet opens", OWNER, ["F&B Director", "Housekeeping Manager"],
    1500, 8000, 10, [0.75, 0.8, 0.5, 0.5]),

  p("Licensed pest control operators", "F&B outlets, childcare centres and clinics", "DIRECT",
    "Licensed technicians and NEA-compliant treatment reporting.",
    "Mandatory recurring treatment tied to keeping their operating licence. Not discretionary.",
    "A new outlet, a licence renewal date, or a failed inspection.",
    "6 weeks before licence renewal", OWNER, ["Outlet Manager", "Centre Principal", "Facilities Manager"],
    2400, 10800, 12, [0.8, 0.75, 0.6, 0.55]),

  p("Fire safety and extinguisher servicing", "Any commercial premises, especially F&B and workshops", "CONTRARIAN",
    "Licensed inspection, servicing and certification paperwork.",
    "Annual certification is legally required and quietly forgotten until an inspection or insurance renewal.",
    "Fire certificate expiry, insurance renewal, or an SCDF inspection notice.",
    "8 weeks before certificate expiry", OWNER, FM,
    600, 6000, 15, [0.7, 0.8, 0.35, 0.5]),

  p("Grease trap and kitchen exhaust cleaning", "Restaurants, hawker operators and central kitchens", "CONTRARIAN",
    "Scheduled degreasing, waste disposal licences and compliance records.",
    "A regulatory requirement and a fire risk they only think about after a blocked drain or a failed check.",
    "NEA inspection cycle, a drainage incident, or a new kitchen opening.",
    "Quarterly, or immediately after an incident", OWNER, ["Outlet Manager", "Head Chef"],
    1800, 9600, 15, [0.7, 0.85, 0.3, 0.45]),

  p("Water tank cleaning and testing", "Condominium MCSTs and commercial building managers", "CONTRARIAN",
    "PUB-compliant cleaning, water sampling and the certification report.",
    "Statutory annual cleaning with a certificate the managing agent must produce on demand.",
    "Annual compliance date or a change of managing agent.",
    "10 weeks before the annual due date", OWNER, ["Managing Agent", "Estate Manager"],
    1200, 8000, 12, [0.65, 0.8, 0.25, 0.45]),

  p("Lift and escalator maintenance", "Strata buildings, malls and older commercial blocks", "DIRECT",
    "Licensed technicians, 24/7 callout and BCA-compliant maintenance records.",
    "Mandatory maintenance regime, and a incumbent contract that comes up for tender.",
    "Maintenance contract expiry or a reportable lift incident.",
    "3–4 months before contract expiry", BD, ["Managing Agent", "Facilities Manager"],
    12000, 90000, 8, [0.6, 0.5, 0.55, 0.4]),

  p("Commercial cleaning contractors", "Offices, clinics, schools and co-working spaces", "DIRECT",
    "Vetted cleaners, supervisor cover and standby replacements.",
    "Coverage that does not collapse when one cleaner resigns — the reason most contracts get switched.",
    "Contract expiry, a service failure, or an office move.",
    "2–3 months before contract expiry", OPS, [...FM, "Office Manager"],
    9600, 72000, 10, [0.7, 0.75, 0.7, 0.5]),

  p("Landscaping and indoor plantscaping", "Corporate offices, hotels and condominium estates", "ADJACENT",
    "Maintenance rounds, plant replacement and seasonal displays.",
    "A lobby that looks cared for, on a recurring contract nobody wants to manage in-house.",
    "An office fit-out completing, a rebrand, or a festive display season.",
    "6 weeks before a fit-out completes", OWNER, ["Office Manager", "Facilities Manager"],
    3600, 30000, 12, [0.55, 0.8, 0.4, 0.4]),

  p("Facade cleaning and rope access", "Commercial building owners and managing agents", "CONTRARIAN",
    "Certified rope-access crews, permits and insurance cover.",
    "Periodic cleaning that needs specialist certification they cannot do in-house.",
    "Pre-tenancy campaigns, building anniversary, or a facade inspection requirement.",
    "8 weeks before a leasing campaign", BD, ["Managing Agent", "Property Manager"],
    8000, 60000, 10, [0.55, 0.6, 0.3, 0.35]),

  p("HVAC servicing contractors", "Facilities managers of strata and commercial buildings", "DIRECT",
    "Scheduled servicing, chiller expertise and emergency response.",
    "Plant that fails in the hottest month, with tenants complaining to the managing agent.",
    "Chiller breakdown, tenant complaints, or a maintenance tender.",
    "Before the March–September heat", OPS, FM,
    6000, 80000, 10, [0.7, 0.7, 0.6, 0.45]),

  // ───────────────────────── PROFESSIONAL SERVICES ──────────────────────────
  p("Outsourced bookkeepers and fractional CFOs", "Startups post-funding and SMEs nearing the audit threshold", "TRIGGER",
    "Qualified accountants, Xero setup and audit-ready process.",
    "Books clean enough to survive due diligence or a statutory audit, on an external deadline.",
    "A funding round, revenue approaching the audit threshold, or a new financial year.",
    "3–4 months before financial year end", ["Managing Partner", "Practice Principal"], [...FIN, "Founder"],
    1500, 6000, 15, [0.75, 0.7, 0.55, 0.5]),

  p("Corporate secretarial firms", "Newly incorporated companies and foreign entrants", "TRIGGER",
    "ACRA filing, registered address, nominee director and annual return handling.",
    "Statutory filings with penalties attached, which a founder discovers late and cannot do themselves.",
    "Incorporation, a change of corporate secretary, or a missed annual return.",
    "Within 30 days of incorporation", ["Director", "Client Manager"], ["Founder", "Finance Manager"],
    800, 4000, 20, [0.7, 0.85, 0.65, 0.5]),

  p("Employment and recruitment agencies", "Companies that just won a contract or raised funding", "TRIGGER",
    "Candidate pipelines and screening for roles the client cannot fill themselves.",
    "Headcount they committed to in a proposal or a board deck, needed faster than they can hire.",
    "A won contract, a funding round, or a resignation in a critical role.",
    "Within 30 days of a contract win", BD, HR,
    6000, 60000, 10, [0.75, 0.7, 0.75, 0.45]),

  p("Employment pass and immigration consultants", "Companies hiring foreign professionals", "TRIGGER",
    "Application experience, quota planning and appeal handling.",
    "A hire who cannot start until a pass is approved, with an offer already signed.",
    "A rejected EP application, a quota breach, or an overseas hire accepting.",
    "Immediately on a rejection or offer", ["Director", "Consultant"], HR,
    1200, 12000, 18, [0.7, 0.75, 0.5, 0.45]),

  p("Corporate insurance brokers", "Companies that recently crossed 20 employees", "TRIGGER",
    "Access to multiple insurers and claims advocacy.",
    "Group health cover, which becomes a retention issue the moment competitors offer it.",
    "Headcount crossing 20, a claim dispute, or policy renewal.",
    "8 weeks before policy renewal", ["Agency Leader", "Practice Principal"], HR,
    6000, 80000, 12, [0.7, 0.8, 0.6, 0.45]),

  p("Trademark and IP lawyers", "Brands launching products or entering new markets", "TRIGGER",
    "Filing strategy, clearance searches and opposition handling.",
    "Protection before a launch, and before a copycat files first in the market they are entering.",
    "A product launch, a regional expansion, or a discovered infringement.",
    "10 weeks before a launch", ["Partner", "Practice Manager"], [...FOUNDER, "Brand Manager"],
    2500, 20000, 15, [0.6, 0.65, 0.45, 0.4]),

  p("Debt collection and receivables agencies", "SMEs with ageing receivables", "CONTRARIAN",
    "Recovery process, legal escalation and the willingness to make the awkward call.",
    "Cash tied up in invoices they are too commercially entangled to chase themselves.",
    "Quarter end, a cash flow squeeze, or a customer entering liquidation.",
    "At quarter end", BD, [...FIN, "Managing Director"],
    2000, 25000, 20, [0.6, 0.7, 0.3, 0.4]),

  p("Grant and incentive consultants", "SMEs eligible for productivity and expansion grants", "CONTRARIAN",
    "Knowledge of which schemes exist and how to write an application that passes.",
    "Funding they qualify for and never claim because the paperwork is opaque.",
    "A planned capital purchase, a digitalisation project, or a grant window opening.",
    "Before committing to a capital purchase", ["Principal Consultant", "Director"], [...FOUNDER, "Finance Manager"],
    3000, 30000, 18, [0.65, 0.7, 0.35, 0.4]),

  p("Company valuation and M&A advisors", "Owners approaching retirement or succession", "CONTRARIAN",
    "Valuation methodology, buyer networks and deal structuring.",
    "An exit they have thought about for years and never started, with no successor in the family.",
    "An owner past 55, a partner exiting, or an unsolicited approach.",
    "12–18 months before an intended exit", ["Partner", "Director"], ["Owner", "Managing Director"],
    15000, 150000, 10, [0.5, 0.4, 0.35, 0.3]),

  // ───────────────────────── TECHNOLOGY & DIGITAL ───────────────────────────
  p("Automation and software freelancers", "HVAC, pest control and cleaning companies", "CONTRARIAN",
    "WhatsApp Business API integration, scheduling automation and simple CRM builds.",
    "Recurring service reminders. Today they wait for the customer to call — every forgotten service is revenue that silently disappears.",
    "Hiring an admin or coordinator role, a visible service backlog, or a second branch.",
    "Any time — the pain is continuous", ["Founder", "Principal Consultant"], [...OWNER, "Operations Manager"],
    8000, 30000, 15, [0.8, 0.85, 0.2, 0.55]),

  p("IT support and managed service providers", "Law firms, clinics and accounting practices", "CONTRARIAN",
    "Helpdesk cover, backup and PDPA-appropriate security setup.",
    "Someone to own IT they cannot justify hiring for, plus obligations they are quietly non-compliant with.",
    "A breach in the news, staff growth, or the partner who 'handles the computers' retiring.",
    "Any time — driven by anxiety, not calendar", ["Director", "Business Development Manager"],
    ["Managing Partner", "Practice Manager"], 9600, 60000, 12, [0.7, 0.7, 0.4, 0.5]),

  p("Cybersecurity auditors and pen testers", "Financial services, healthcare and anyone holding customer data", "TRIGGER",
    "Testing methodology, a report their client or regulator will accept, and remediation advice.",
    "An audit requirement imposed by a client, an insurer, or a regulator — not by their own concern.",
    "A client security questionnaire, cyber insurance renewal, or a breach in their sector.",
    "On receipt of a client security questionnaire", ["Director", "Practice Lead"], ["IT Manager", "Compliance Officer"],
    8000, 60000, 12, [0.7, 0.6, 0.5, 0.45]),

  p("POS and payment system vendors", "F&B and retail outlets opening or re-fitting", "TRIGGER",
    "Hardware, integration with accounting, and installation before opening day.",
    "A till that works on day one, integrated with the stock and accounts they already run.",
    "A new outlet, a POS contract expiry, or an integration failure at month end.",
    "4 weeks before an outlet opens", BD, [...OWNER, "Operations Manager"],
    3000, 25000, 12, [0.7, 0.75, 0.65, 0.45]),

  p("E-commerce and marketplace agencies", "Traditional retailers and wholesalers going direct", "TRIGGER",
    "Store build, marketplace onboarding and fulfilment integration.",
    "A channel their distributor relationships no longer cover, with competitors already there.",
    "Falling wholesale orders, a competitor launching online, or a marketplace invitation.",
    "Q3, before the festive trading period", ["Account Director", "Founder"], [...MKT, "Managing Director"],
    6000, 50000, 15, [0.65, 0.8, 0.7, 0.45]),

  p("Inventory and warehouse software vendors", "Distributors and wholesalers running on spreadsheets", "CONTRARIAN",
    "Stock accuracy, barcode workflows and reorder automation.",
    "Knowing what they actually have. Stock counts that take a weekend and are wrong by Monday.",
    "A stock write-off, a failed audit, or opening a second warehouse.",
    "Before financial year end stocktake", BD, [...OPS, "Warehouse Manager"],
    8000, 60000, 12, [0.65, 0.65, 0.4, 0.4]),

  p("Web developers and site maintainers", "SMEs whose site is unmaintained or client-rendered", "ADJACENT",
    "Rebuild, hosting, and someone who answers when the site goes down.",
    "A site that loads slowly, cannot be edited, and is invisible to search — usually built by someone who left.",
    "A site outage, a failed security scan, or a rebrand.",
    "Any time — worsens gradually", FOUNDER, [...MKT, "Owner"],
    3000, 25000, 15, [0.6, 0.85, 0.8, 0.45]),

  p("AI and chatbot implementers", "High-enquiry-volume businesses: clinics, agents, tuition centres", "TRIGGER",
    "Enquiry triage, booking flows and after-hours coverage.",
    "Enquiries arriving after hours that go unanswered until morning, by which time the customer booked elsewhere.",
    "Hiring a receptionist, visible response delays, or a competitor launching instant booking.",
    "Any time", FOUNDER, [...OWNER, "Operations Manager"],
    5000, 40000, 15, [0.7, 0.8, 0.35, 0.45]),

  // ───────────────────────── MARKETING & CREATIVE ───────────────────────────
  p("Photography and video production studios", "Property launches, F&B openings and e-commerce brands", "SEASONAL",
    "Production crew, studio space and fast editing turnaround.",
    "Launch content against a fixed date that cannot slip because the launch cannot slip.",
    "A property launch, a TOP handover, a product drop, or a festive campaign.",
    "6–8 weeks before a launch date", ["Studio Owner", "Producer"], [...MKT, "Sales Gallery Manager"],
    3000, 25000, 15, [0.7, 0.85, 0.65, 0.5]),

  p("Print, signage and large-format producers", "Retail and F&B chains opening or rebranding", "TRIGGER",
    "Fabrication, permits for external signage, and installation to a deadline.",
    "Signage that must be up before the landlord's handover date and the opening announcement.",
    "A signed lease, a rebrand, or a landlord fit-out deadline.",
    "5 weeks before opening", BD, [...MKT, "Expansion Manager"],
    2000, 30000, 12, [0.7, 0.8, 0.6, 0.45]),

  p("Packaging designers and producers", "F&B manufacturers and DTC brands launching a product", "TRIGGER",
    "Structural design, compliance labelling and minimum-order production.",
    "Packaging that meets labelling rules for their target market and arrives before the launch date.",
    "A product launch, an export market entry, or a labelling rejection.",
    "10 weeks before a launch", BD, [...FOUNDER, "Brand Manager"],
    4000, 45000, 12, [0.65, 0.7, 0.5, 0.4]),

  p("PR and communications agencies", "Recently funded startups and companies in a crisis", "TRIGGER",
    "Journalist relationships, announcement strategy and crisis handling.",
    "Coverage of a raise while it is still news, or control of a story already running.",
    "A funding round, an award, a product launch, or a negative story.",
    "Within 2 weeks of a funding announcement", ["Account Director", "Founder"], [...MKT, "Chief of Staff"],
    5000, 60000, 15, [0.6, 0.7, 0.6, 0.4]),

  p("Branding and identity studios", "Companies post-merger, post-pivot or entering a new market", "TRIGGER",
    "Naming, identity systems and rollout guidelines.",
    "One coherent identity after a merger left them running two, or a name that does not travel.",
    "A merger, an acquisition, a pivot, or regional expansion.",
    "Immediately post-merger", ["Founder", "Creative Director"], [...MKT, "Managing Director"],
    8000, 80000, 12, [0.55, 0.6, 0.55, 0.35]),

  p("Exhibition stand builders", "Companies booked into a trade show", "SEASONAL",
    "Design, fabrication, logistics and on-site build to the organiser's rules.",
    "A stand that must exist on a fixed date, at a venue with strict build windows.",
    "A confirmed trade show booking.",
    "10 weeks before the show", BD, [...MKT, "Sales Director"],
    8000, 90000, 12, [0.7, 0.7, 0.5, 0.45]),

  p("Corporate event and experiential agencies", "Companies with recurring town halls, D&Ds and conferences", "CHANNEL",
    "Production, venue relationships and supplier coordination.",
    "An annual event nobody internally has time to run, with a board watching.",
    "Annual dinner season, a company anniversary, or a conference commitment.",
    "12 weeks before the event", ["Account Director", "Production Lead"], [...HR, "Chief of Staff"],
    10000, 120000, 12, [0.7, 0.7, 0.55, 0.45]),

  p("Translation and localisation agencies", "E-commerce and SaaS expanding into Southeast Asia", "TRIGGER",
    "Native translators and a workflow that handles product copy at volume.",
    "Bahasa, Thai and Vietnamese versions before launch. Machine translation visibly fails on product copy.",
    "An announced regional expansion, a new market hire, or a funding round for growth.",
    "8–10 weeks before a market launch", ["Account Director", "Owner"], ["Head of Growth", "Regional Director"],
    2000, 20000, 15, [0.6, 0.8, 0.45, 0.4]),

  // ───────────────────────── SUPPLY & GOODS ─────────────────────────────────
  p("Corporate gifting and hamper suppliers", "Banks, law firms and professional services", "SEASONAL",
    "Bulk production, custom branding and delivery capacity at peak.",
    "Client appreciation gifts on a budget allocated annually and spent in a narrow window.",
    "Year-end client appreciation, Chinese New Year, or a client anniversary programme.",
    "8–10 weeks before the festive period", BD, [...HR, "Client Relationship Director"],
    8000, 60000, 12, [0.8, 0.8, 0.7, 0.55]),

  p("Florists and event floral suppliers", "Hotels, corporate offices and event organisers", "SEASONAL",
    "Weekly arrangement rounds, event installations and festive displays.",
    "Reception and lobby presentation on a recurring contract, plus event peaks.",
    "Valentine's Day, Mother's Day, festive season, or a new office opening.",
    "6–8 weeks before a peak date", OWNER, ["Office Manager", "F&B Director"],
    2400, 30000, 15, [0.7, 0.85, 0.5, 0.5]),

  p("Uniform and corporate apparel suppliers", "Security firms, cleaning companies and F&B chains", "ADJACENT",
    "Bulk garment production, embroidery and sizing logistics.",
    "Uniforms for new headcount, or a refresh after a rebrand. Headcount converts directly into unit orders.",
    "A hiring spree, a won contract, or a rebrand.",
    "Immediately after a contract win", BD, [...HR, "Operations Director"],
    3000, 40000, 12, [0.7, 0.8, 0.5, 0.5]),

  p("Office coffee, pantry and vending suppliers", "Offices, co-working spaces and clinics", "DIRECT",
    "Equipment, recurring supply and machine servicing.",
    "A pantry that never runs out, on a contract the office manager can forget about.",
    "An office move, headcount growth, or a return-to-office push.",
    "4 weeks before an office move", BD, ["Office Manager", "Facilities Manager"],
    3600, 36000, 12, [0.65, 0.85, 0.6, 0.45]),

  p("Office furniture and workspace suppliers", "Companies moving, expanding or reconfiguring", "TRIGGER",
    "Space planning, bulk supply and installation over a weekend.",
    "Desks in place before staff arrive on Monday, coordinated with the fit-out contractor.",
    "A signed office lease, a headcount jump, or a hybrid-work reconfiguration.",
    "6 weeks before a move-in date", BD, ["Office Manager", "Head of People"],
    10000, 150000, 10, [0.65, 0.7, 0.55, 0.4]),

  p("Commercial kitchen equipment suppliers", "F&B outlets opening or replacing failed equipment", "TRIGGER",
    "Specification, supply, installation and servicing cover.",
    "Equipment specified to fit the space and the menu, delivered before the opening date.",
    "A new outlet, a kitchen refit, or a critical equipment failure.",
    "8 weeks before opening", BD, [...OWNER, "Head Chef"],
    15000, 200000, 8, [0.7, 0.6, 0.5, 0.4]),

  p("Packaging and disposables suppliers", "F&B outlets, cloud kitchens and e-commerce sellers", "DIRECT",
    "Volume pricing, custom printing and reliable restocking.",
    "Consistent supply of the thing that stops service when it runs out, at a price that survives delivery margins.",
    "A new outlet, a delivery-platform launch, or a supplier price rise.",
    "Any time — consumption is continuous", BD, [...PROC, "Operations Manager"],
    4800, 60000, 10, [0.7, 0.85, 0.75, 0.45]),

  p("PPE and workplace safety suppliers", "Construction, manufacturing and logistics operators", "TRIGGER",
    "Certified equipment, sizing across a workforce and compliance documentation.",
    "Equipment that satisfies an MOM inspection and an insurer, for headcount that changes constantly.",
    "A workplace incident, an MOM inspection, or a new project mobilisation.",
    "At project mobilisation", BD, ["Safety Officer", "Project Manager"],
    5000, 60000, 10, [0.7, 0.8, 0.5, 0.45]),

  // ───────────────────────── LOGISTICS & FLEET ──────────────────────────────
  p("Third-party logistics and fulfilment operators", "E-commerce brands outgrowing their own storeroom", "TRIGGER",
    "Warehouse space, pick-and-pack, and integrations with the major marketplaces.",
    "Fulfilment that scales past the founder packing boxes in the evening, before peak season.",
    "A sales spike, a marketplace launch, or a warehouse lease expiring.",
    "10 weeks before peak trading", BD, [...FOUNDER, "Operations Manager"],
    12000, 150000, 10, [0.7, 0.65, 0.55, 0.45]),

  p("Cold chain and temperature-controlled logistics", "F&B manufacturers, pharmacies and grocery sellers", "TRIGGER",
    "Refrigerated fleet, temperature logging and compliance records.",
    "Delivery that does not spoil the product, with an audit trail their own customers demand.",
    "A spoilage incident, a new retail listing, or an audit requirement.",
    "Before a retail listing goes live", BD, [...OPS, "Quality Manager"],
    15000, 180000, 8, [0.65, 0.55, 0.4, 0.4]),

  p("Fleet leasing and telematics providers", "Delivery, logistics and field-service operators scaling", "TRIGGER",
    "Vehicles without capital outlay, plus tracking, maintenance and driver reporting.",
    "More vehicles without a balance-sheet hit, and visibility of where they actually are.",
    "A won delivery contract, fleet expansion, or an insurance claim.",
    "Within 30 days of a contract win", BD, [...OPS, "Fleet Manager"],
    20000, 250000, 8, [0.65, 0.6, 0.5, 0.4]),

  p("Freight forwarders and customs brokers", "Importers and exporters entering new markets", "TRIGGER",
    "Route options, customs documentation and duty classification.",
    "Shipments cleared without a hold, into a market whose paperwork they have never handled.",
    "A new supplier country, an export market entry, or a customs seizure.",
    "Before the first shipment", BD, [...PROC, "Export Manager"],
    8000, 120000, 8, [0.6, 0.6, 0.6, 0.35]),

  p("Specimen and medical courier services", "Clinics, labs and dental practices", "CONTRARIAN",
    "Timed pickups, chain-of-custody handling and trained couriers.",
    "Samples that reach the lab within the viability window, reliably, every day.",
    "A lab switching provider, a missed pickup, or a new clinic opening.",
    "At clinic opening", BD, ["Practice Manager", "Clinic Director"],
    6000, 40000, 12, [0.6, 0.7, 0.25, 0.35]),

  // ───────────────────────── HEALTH & WORKFORCE ─────────────────────────────
  p("Corporate wellness, physio and massage providers", "Technology companies post-funding and co-working spaces", "TRIGGER",
    "Licensed therapists, on-site setup and a recurring booking model.",
    "Perks that retain engineers. After a raise there is budget and a mandate to spend it on retention.",
    "A funding round, a new office lease, or headcount passing 30.",
    "Within 90 days of a raise", ["Owner", "Clinic Manager"], [...HR, "Office Manager"],
    2000, 15000, 15, [0.7, 0.75, 0.4, 0.45]),

  p("Occupational health screening providers", "Manufacturing, construction and food handling employers", "CONTRARIAN",
    "Statutory medical examinations, audiometry and reporting to MOM.",
    "Legally required screening for specific job categories, on an annual cycle with penalties.",
    "The annual screening cycle, a new hire cohort, or an MOM audit.",
    "6 weeks before the annual cycle", BD, [...HR, "Safety Officer"],
    3000, 40000, 12, [0.7, 0.7, 0.3, 0.45]),

  p("First aid and safety training providers", "Any workplace with a statutory first-aider requirement", "CONTRARIAN",
    "Accredited courses, on-site delivery and certification tracking.",
    "Certified first-aiders whose certificates expire on a rolling basis nobody tracks.",
    "Certificate expiry, a workplace incident, or an audit.",
    "8 weeks before certificates expire", BD, [...HR, "Safety Officer"],
    1500, 15000, 15, [0.65, 0.8, 0.35, 0.4]),

  p("Corporate training and SkillsFuture providers", "SMEs with unused training subsidy entitlement", "CONTRARIAN",
    "Accredited courses and the subsidy paperwork most SMEs will not attempt.",
    "Training that is largely funded and therefore nearly free, which they never get around to claiming.",
    "Financial year end, a subsidy scheme deadline, or a performance review cycle.",
    "Before the subsidy window closes", BD, HR,
    4000, 40000, 15, [0.6, 0.75, 0.4, 0.35]),

  // ───────────────────────── CONSTRUCTION & PROPERTY ────────────────────────
  p("Interior fit-out contractors", "Retail chains, F&B groups and clinics expanding", "TRIGGER",
    "Licensed contractors, permit experience and project management.",
    "A unit built out before the rent-free period ends. Every week late costs rent on an empty shop.",
    "A signed lease, an announced expansion, or a landlord handover date.",
    "Immediately after a lease is signed", BD, ["Expansion Manager", "Operations Director"],
    30000, 300000, 8, [0.7, 0.55, 0.5, 0.45]),

  p("Commercial property agents", "Companies whose lease expires within twelve months", "TRIGGER",
    "Market knowledge, landlord relationships and negotiation on renewal terms.",
    "A better deal than the renewal letter their landlord just sent, or a move they have no time to plan.",
    "A lease expiry date, a headcount change, or a rent review.",
    "9–12 months before lease expiry", BD, [...FIN, "Office Manager"],
    10000, 150000, 10, [0.65, 0.6, 0.7, 0.4]),

  p("Office relocation and workplace movers", "Companies with a confirmed move date", "TRIGGER",
    "Weekend moves, IT decommissioning and reinstatement of the old premises.",
    "A move that happens over a weekend so nobody loses a working day.",
    "A signed lease on new premises.",
    "6 weeks before the move", BD, ["Office Manager", "Facilities Manager"],
    8000, 80000, 10, [0.7, 0.75, 0.5, 0.45]),

  p("Serviced office and co-working operators", "Foreign companies establishing a Singapore presence", "CHANNEL",
    "Ready space, a registered address and short commitment terms.",
    "A base to operate from before they know how big they will be.",
    "An announced market entry, an incorporation, or a first local hire.",
    "At incorporation", BD, ["Regional Director", "Country Manager"],
    12000, 100000, 10, [0.6, 0.7, 0.65, 0.4]),

  // ───────────────────────── FOOD & HOSPITALITY ─────────────────────────────
  p("Corporate caterers", "Offices with recurring town halls, training and client events", "SEASONAL",
    "Volume capacity, dietary handling and reliable delivery windows.",
    "Food for a fixed headcount at a fixed time, where late or wrong is highly visible.",
    "A recurring town hall schedule, a training programme, or festive celebrations.",
    "4 weeks before an event series", BD, [...HR, "Office Manager"],
    5000, 60000, 12, [0.7, 0.85, 0.65, 0.5]),

  p("Coffee roasters and wholesale bakeries", "Independent cafés, hotels and co-working operators", "CHANNEL",
    "Consistent supply, equipment loans and barista training.",
    "A house blend and daily pastry supply without running their own production.",
    "A café opening, a supplier price rise, or a quality complaint.",
    "6 weeks before opening", BD, [...OWNER, "F&B Director"],
    6000, 60000, 12, [0.65, 0.8, 0.6, 0.45]),

  p("Halal certification and compliance consultants", "F&B manufacturers expanding into Malaysia and Indonesia", "TRIGGER",
    "MUIS process knowledge, audit preparation and documentation experience.",
    "Certification before they can legally sell into their target market. A hard gate.",
    "An announced expansion, a distributor agreement, or a rejected shipment.",
    "As soon as expansion is announced", ["Principal Consultant", "Director"], ["Export Manager", "Quality Manager"],
    5000, 25000, 12, [0.75, 0.6, 0.25, 0.45]),

  p("Food safety and HACCP consultants", "Central kitchens, manufacturers and catering operators", "TRIGGER",
    "System design, documentation and audit preparation.",
    "Certification a retail buyer or export market demands before they will place an order.",
    "A retail listing requirement, a failed audit, or an export market entry.",
    "Before a buyer audit", ["Principal Consultant", "Director"], ["Quality Manager", "Operations Director"],
    6000, 40000, 12, [0.65, 0.6, 0.3, 0.4]),

  // ───────────────────────── FINANCE ────────────────────────────────────────
  p("Invoice financing and working capital lenders", "SMEs supplying large corporates on long payment terms", "TRIGGER",
    "Advance against invoices without a property charge.",
    "Cash now instead of in 90 days, so they can accept the next order.",
    "A large order they cannot fund, a payment term extension, or a supplier demanding deposit.",
    "At the point of a large order", BD, [...FIN, "Managing Director"],
    5000, 100000, 8, [0.65, 0.6, 0.5, 0.35]),

  p("Payment gateway and merchant service providers", "Retailers and service businesses taking payment offline", "TRIGGER",
    "Lower processing rates, faster settlement and online checkout.",
    "Rates they have never renegotiated, on volume that has grown since they signed.",
    "A volume increase, an e-commerce launch, or a settlement delay.",
    "Any time — savings compound", BD, [...FIN, "Owner"],
    2000, 40000, 12, [0.6, 0.8, 0.7, 0.35]),

  p("Equipment leasing and hire-purchase providers", "Capital-intensive SMEs: F&B, printing, construction", "TRIGGER",
    "Equipment without the capital outlay, structured against the asset.",
    "Machinery they need and cannot buy outright without stalling everything else.",
    "An equipment failure, a capacity constraint, or a won contract requiring capability.",
    "At the point of an equipment decision", BD, [...FIN, "Operations Director"],
    10000, 200000, 6, [0.6, 0.6, 0.55, 0.35]),

  // ───────────────────────── SUSTAINABILITY & COMPLIANCE ────────────────────
  p("Waste management and recycling operators", "Manufacturers and listed companies under ESG reporting duties", "TRIGGER",
    "Licensed disposal, weight tracking and the reporting data nobody else produces.",
    "Auditable waste figures for a sustainability report. The data requirement is what is new, not the waste.",
    "New sustainability reporting requirements, an ISO audit, or a first sustainability hire.",
    "Before the reporting period closes", BD, ["Sustainability Manager", "Operations Director"],
    12000, 120000, 10, [0.65, 0.6, 0.35, 0.4]),

  p("Energy audit and solar installers", "Manufacturers and building owners with high tariffs", "TRIGGER",
    "Load analysis, installation and payback modelling.",
    "A utility bill that has become a board-level line item, with grants available against it.",
    "A tariff increase, an ESG commitment, or a grant window.",
    "Before a grant window closes", BD, [...FM, "Operations Director"],
    20000, 300000, 8, [0.6, 0.55, 0.45, 0.35]),

  p("Data protection and PDPA consultants", "Clinics, schools, agencies and anyone holding customer records", "CONTRARIAN",
    "Gap assessment, policy drafting and a named DPO service.",
    "A legal requirement to appoint a data protection officer that most SMEs have quietly ignored.",
    "An enforcement action in their sector, a client questionnaire, or a data incident.",
    "Any time — driven by enforcement news", ["Principal Consultant", "Director"],
    ["Practice Manager", "Compliance Officer"], 3000, 30000, 15, [0.65, 0.75, 0.3, 0.4]),
];
