import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './pages/Dashboard';
import { UpdatePage } from './pages/UpdatePage';
import { SshKeysPage } from './pages/SshKeysPage';
import { ProvisioningForm } from './pages/ProvisioningForm';
import { MaintenancePage } from './pages/MaintenancePage';
import { JobHistory } from './pages/JobHistory';
import { JobView } from './pages/JobView';
import { UsersPage } from './pages/UsersPage';
import { PermissionsPage } from './pages/PermissionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { NetworkingPage } from './pages/NetworkingPage';
import { ThemeProvider } from './lib/theme';
import { WhoAmIProvider, useWhoAmI } from './lib/whoami';

// Keying <main> on `generation` remounts every routed page on a completed
// refresh() (impersonation start/stop -- research R1) so page data fetched
// at mount time (Dashboard inventory, guest status, jobs) picks up the new
// viewer's server-side filtering instead of staying stuck showing the
// previous viewer's data. `generation` only changes via refresh(), never
// via the initial load(), so an ordinary page load never remounts. This has
// to be its own component so useWhoAmI() runs inside WhoAmIProvider rather
// than in App itself, which renders outside the provider it creates.
function AppShell() {
  const { generation } = useWhoAmI();
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="content" key={generation}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/update" element={<UpdatePage />} />
          <Route path="/ssh-keys" element={<SshKeysPage />} />
          <Route path="/provisioning/:id" element={<ProvisioningForm />} />
          <Route path="/maintenance/:id" element={<MaintenancePage />} />
          <Route path="/networking" element={<NetworkingPage />} />
          <Route path="/jobs" element={<JobHistory />} />
          <Route path="/jobs/:id" element={<JobView />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/permissions" element={<PermissionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <WhoAmIProvider>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </WhoAmIProvider>
    </ThemeProvider>
  );
}
