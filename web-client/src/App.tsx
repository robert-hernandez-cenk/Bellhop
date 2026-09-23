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

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <div className="app-shell">
          <Sidebar />
          <main className="content">
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
      </BrowserRouter>
    </ThemeProvider>
  );
}
