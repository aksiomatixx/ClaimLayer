/**
 * TopNav portal-nav flag (CL-MKT1): the worker/employer mode switcher
 * renders by default and is hidden when VITE_SHOW_PORTAL_NAV='false'
 * (the demo/marketing build). The underlying views are untouched —
 * only the navigation affordance is gated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopNav } from '../components/TopNav.jsx';

const PROPS = {
  role: 'admin',
  setRole: () => {},
  claims: [],
  adminView: 'claims',
  setAdminView: () => {},
};

afterEach(() => vi.unstubAllEnvs());

describe('TopNav portal navigation flag', () => {
  it('renders the Admin / Employer / Employee switcher by default (flag on)', () => {
    render(<TopNav {...PROPS} />);
    expect(screen.getByText('⚡ Admin')).toBeInTheDocument();
    expect(screen.getByText('🏢 Employer')).toBeInTheDocument();
    expect(screen.getByText('👤 Employee')).toBeInTheDocument();
  });

  it('hides the worker/employer pills when the flag is off (demo build)', () => {
    vi.stubEnv('VITE_SHOW_PORTAL_NAV', 'false');
    render(<TopNav {...PROPS} />);
    expect(screen.queryByText('🏢 Employer')).toBeNull();
    expect(screen.queryByText('👤 Employee')).toBeNull();
    // The INTERNAL switcher stays: the supervisor surface is a separate
    // authenticated session (its endpoints 403 admin cookies), so the
    // adjuster-side roles must remain reachable even in the demo build.
    expect(screen.getByText('⚡ Admin')).toBeInTheDocument();
    expect(screen.getByText('👁 Supervisor')).toBeInTheDocument();
    // The admin surface itself still renders (view tabs intact).
    expect(screen.getByText('Claims')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('shows the supervisor pill alongside the portal pills when the flag is on', () => {
    render(<TopNav {...PROPS} />);
    expect(screen.getByText('👁 Supervisor')).toBeInTheDocument();
  });

  it('an explicit true keeps the switcher (normal app unchanged)', () => {
    vi.stubEnv('VITE_SHOW_PORTAL_NAV', 'true');
    render(<TopNav {...PROPS} />);
    expect(screen.getByText('👤 Employee')).toBeInTheDocument();
  });
});
