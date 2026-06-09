/**
 * App smoke test — verifies the post-modularization wiring at runtime.
 *
 * Renders the real <App/> (with fetch mocked) and exercises both portals
 * that consume the extracted modules:
 *   - employee portal → EmployeeIntakeWizard (+ LanguageSelector, StepBar,
 *     primitives, mockData, theme)
 *   - admin portal → AdminDashboard (+ ActionQueue, StatCard, Tabs)
 * Also covers the ErrorBoundary fallback that wraps the root in main.jsx.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import '../i18n.js';
import App from '../App.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';

function jsonRes(body) {
  return { ok: true, status: 200, json: async () => body, blob: async () => new Blob() };
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/claims')) return jsonRes({ claims: [] });
    if (u.includes('/rfas')) return jsonRes({ rfas: [] });
    if (u.includes('/auth/')) return jsonRes({ ok: true });
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  );
}

describe('App smoke (post-modularization wiring)', () => {
  it('renders the employee portal with the extracted intake wizard by default', () => {
    renderApp();
    expect(screen.getByText('Employee Portal')).toBeInTheDocument();
    // wizard step 0 (EmployeeIntakeWizard + Field/Lbl primitives)
    expect(screen.getByText('Your Information')).toBeInTheDocument();
    expect(screen.getByText('Your Full Legal Name *')).toBeInTheDocument();
    // LanguageSelector toggle button
    expect(screen.getByRole('button', { name: 'EN · ES' })).toBeInTheDocument();
  });

  it('switches to the admin role and renders the extracted AdminDashboard', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: /Admin/ }));
    expect(await screen.findByText('Claims Console')).toBeInTheDocument();
    // StatCard primitives + ActionQueue empty state
    expect(screen.getByText('Total Claims')).toBeInTheDocument();
    expect(
      await screen.findByText('No claims require immediate action')
    ).toBeInTheDocument();
  });
});

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>healthy subtree</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('healthy subtree')).toBeInTheDocument();
  });

  it('shows the fallback with the error message when a child throws', () => {
    const Boom = () => {
      throw new Error('kaboom');
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
