-- ============================================================
-- M5 — Seed Data
-- Employers, provider MPN directory, and Supabase Auth users.
--
-- NOTE: Supabase Auth users (for employer portal login) must be
-- created via the Supabase Dashboard or the Auth Admin API —
-- they cannot be inserted directly into auth.users via SQL.
-- See docs/supabase-auth-setup.md for instructions.
-- ============================================================

-- ── Employers ─────────────────────────────────────────────────────────────────
-- ORDER-INDEPENDENCE RETROFIT: this seed was extended with insurer fields
-- when the M22A prebuild landed, which broke fresh-database installs (the
-- columns are added by 20260102000005, which sorts AFTER this file). The
-- guarded ADD COLUMNs below make the chain order-clean on a fresh apply;
-- on databases where this migration already ran they never re-execute,
-- and 20260102000005's own IF NOT EXISTS statements remain no-ops.
ALTER TABLE employers ADD COLUMN IF NOT EXISTS insurer_fein VARCHAR(9);
ALTER TABLE employers ADD COLUMN IF NOT EXISTS insurer_name VARCHAR(200);
ALTER TABLE employers ADD COLUMN IF NOT EXISTS self_insured BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO employers (id, name, address_line1, address_city, address_state, address_zip, phone, primary_contact_email, fein, self_insured, insurer_name, insurer_fein)
VALUES
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567801', 'BrightCare Home Health',
     '1200 W 7th St, Suite 300', 'Los Angeles', 'CA', '90017', '(213) 555-2000',
     'hr@brightcarehh.com',
     '111111111', TRUE, 'BrightCare Home Health', '111111111'),
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567802', 'CareWell Services',
     '500 N Brand Blvd, Suite 700', 'Glendale', 'CA', '91203', '(818) 555-3000',
     'hr@carewellservices.com',
     '222222222', FALSE, 'TEST CARRIER A', '555555555'),
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567803', 'SunRise Home Care',
     '22700 Ventura Blvd, Suite 200', 'Woodland Hills', 'CA', '91364', '(818) 555-4000',
     'hr@sunrisehomecare.com',
     '333333333', FALSE, 'TEST CARRIER B', '666666666')
ON CONFLICT (id) DO NOTHING;

-- ── MPN Providers (15 LA-area providers) ──────────────────────────────────────
INSERT INTO providers (id, name, specialty, address_line1, city, state, zip, phone, fax, email, mpn_tier, walk_in, rating, hours, languages, accepting_new_wc)
VALUES
    ('prov_001', 'Pacific Occupational Medicine — Koreatown', 'Occupational Medicine',
     '3756 W 6th St, Suite 200', 'Los Angeles', 'CA', '90057',
     '(213) 555-0110', '(213) 555-0111', 'wc@pacificocmed.com',
     1, FALSE, 4.7, 'Mon–Fri 8am–5pm', '["English","Spanish","Korean"]', TRUE),

    ('prov_002', 'Olympic Medical Group — Mid-Wilshire', 'Occupational Medicine',
     '3470 Wilshire Blvd, Suite 820', 'Los Angeles', 'CA', '90010',
     '(213) 555-0210', '(213) 555-0211', 'wc@olympicmedgroup.com',
     1, FALSE, 4.5, 'Mon–Fri 8am–6pm, Sat 9am–1pm', '["English","Spanish"]', TRUE),

    ('prov_003', 'Wilshire Occupational Health Center', 'Occupational Medicine',
     '3055 Wilshire Blvd, Suite 310', 'Los Angeles', 'CA', '90010',
     '(213) 555-0312', '(213) 555-0313', 'scheduling@wilshireocchealth.com',
     2, FALSE, 4.2, 'Mon–Fri 8:30am–5:30pm', '["English","Tagalog"]', TRUE),

    ('prov_004', 'Hancock Park Occupational Medicine', 'Occupational Medicine',
     '131 N Larchmont Blvd, Suite 100', 'Los Angeles', 'CA', '90020',
     '(323) 555-0410', '(323) 555-0411', 'wc@hancockparkocc.com',
     2, FALSE, 4.3, 'Mon–Fri 9am–5pm', '["English","Spanish","Armenian"]', TRUE),

    ('prov_005', 'Fairfax District Occupational Health', 'Occupational Medicine',
     '8920 Wilshire Blvd, Suite 500', 'Beverly Hills', 'CA', '90036',
     '(310) 555-0510', '(310) 555-0511', 'occmed@fairfaxocchealth.com',
     2, FALSE, 4.1, 'Mon–Fri 8am–5pm', '["English","Spanish","Hebrew"]', TRUE),

    ('prov_006', 'LA Orthopedic Specialists — Wilshire', 'Orthopedic Surgery',
     '3811 Wilshire Blvd, Suite 600', 'Los Angeles', 'CA', '90057',
     '(213) 555-0610', '(213) 555-0611', 'wc@laorthospecialists.com',
     1, FALSE, 4.8, 'Mon–Fri 8am–5pm', '["English","Spanish"]', TRUE),

    ('prov_007', 'LA Sports Medicine & Orthopedics — Fairfax', 'Orthopedic Surgery',
     '7601 Beverly Blvd, Suite 300', 'Los Angeles', 'CA', '90036',
     '(323) 555-0710', '(323) 555-0711', 'wc@lasportsortho.com',
     2, FALSE, 4.6, 'Mon–Fri 8am–6pm', '["English","Spanish"]', TRUE),

    ('prov_008', 'Moorpark Orthopedic Surgery Center', 'Orthopedic Surgery',
     '18250 Technology Dr, Suite 150', 'Moorpark', 'CA', '93021',
     '(805) 555-0810', '(805) 555-0811', 'wc@moorparkortho.com',
     2, FALSE, 4.4, 'Mon–Fri 8am–5pm', '["English","Spanish"]', TRUE),

    ('prov_009', 'Koreatown Urgent Care & Occupational Health', 'Urgent Care',
     '2930 W Olympic Blvd', 'Los Angeles', 'CA', '90057',
     '(213) 555-0910', '(213) 555-0911', 'wc@koreatown-urgentcare.com',
     1, TRUE, 4.4, 'Mon–Fri 7am–8pm, Sat–Sun 8am–5pm', '["English","Spanish","Korean"]', TRUE),

    ('prov_010', 'Beverly & Western Medical Center', 'Urgent Care',
     '5428 W Beverly Blvd', 'Los Angeles', 'CA', '90020',
     '(323) 555-1010', '(323) 555-1011', 'wc@beverlywesternmed.com',
     2, TRUE, 4.0, 'Mon–Sun 8am–9pm', '["English","Spanish","Tagalog"]', TRUE),

    ('prov_011', 'Fairfax Urgent Care Center', 'Urgent Care',
     '500 N Fairfax Ave', 'Los Angeles', 'CA', '90036',
     '(323) 555-1110', '(323) 555-1111', 'wc@fairfaxurgentcare.com',
     2, TRUE, 4.1, 'Mon–Sun 8am–8pm', '["English","Spanish","Hebrew","Russian"]', TRUE),

    ('prov_012', 'Moorpark Community Urgent Care', 'Urgent Care',
     '375 Los Angeles Ave, Suite 101', 'Moorpark', 'CA', '93021',
     '(805) 555-1210', '(805) 555-1211', 'wc@moorparkurgentcare.com',
     2, FALSE, 3.9, 'Mon–Fri 8am–6pm, Sat 9am–3pm', '["English","Spanish"]', TRUE),

    ('prov_013', 'Mid-Wilshire Physical Therapy & Rehabilitation', 'Physical Therapy',
     '3575 Cahuenga Blvd W, Suite 240', 'Los Angeles', 'CA', '90010',
     '(213) 555-1310', '(213) 555-1311', 'wc@midwilshrept.com',
     2, FALSE, 4.5, 'Mon–Fri 7am–7pm', '["English","Spanish"]', TRUE),

    ('prov_014', 'Western Avenue Rehabilitation & Physical Therapy', 'Physical Therapy',
     '4141 W 3rd St, Suite 100', 'Los Angeles', 'CA', '90020',
     '(323) 555-1410', '(323) 555-1411', 'wc@westernaptrehab.com',
     2, FALSE, 4.3, 'Mon–Fri 7am–6pm', '["English","Spanish","Armenian"]', TRUE),

    ('prov_015', 'Miracle Mile Physical Therapy Group', 'Physical Therapy',
     '5455 Wilshire Blvd, Suite 1210', 'Los Angeles', 'CA', '90036',
     '(323) 555-1510', '(323) 555-1511', 'wc@miraclemilept.com',
     2, FALSE, 4.6, 'Mon–Fri 7am–7pm, Sat 8am–12pm', '["English","Spanish"]', TRUE)

ON CONFLICT (id) DO NOTHING;
