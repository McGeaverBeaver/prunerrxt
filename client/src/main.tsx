import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import App from './App';
import i18n from './i18n';
import { ToastProvider } from './components/common/Toast';
import { DisplayPreferencesProvider } from './contexts/DisplayPreferencesContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { AuthProvider } from './contexts/AuthContext';
// Fonts ship inside the bundle; the browser never contacts a font CDN.
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/dm-sans/wght-italic.css';
import '@fontsource-variable/outfit';
import '@fontsource-variable/jetbrains-mono';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <DisplayPreferencesProvider>
            <BrowserRouter>
              <ToastProvider>
                <AuthProvider>
                  <App />
                </AuthProvider>
              </ToastProvider>
            </BrowserRouter>
          </DisplayPreferencesProvider>
        </I18nextProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>
);
