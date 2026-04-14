import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/intake.json';
import es from './locales/es/intake.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { intake: en },
      es: { intake: es },
    },
    lng:        localStorage.getItem('lang') || 'en',
    fallbackLng: 'en',
    ns:         ['intake'],
    defaultNS:  'intake',
    interpolation: {
      escapeValue: false, // React handles XSS escaping
    },
  });

// Persist language changes to localStorage
i18n.on('languageChanged', (lng) => {
  localStorage.setItem('lang', lng);
  document.documentElement.lang = lng;
});

export default i18n;
