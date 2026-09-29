/**
 * Examples Page Component
 *
 * Displays the examples gallery. Clicking a tile navigates to
 * `/example/<id>` — ExampleEditorPage owns the actual load (library
 * install, store mutations) and keeps the URL pinned for the lifetime
 * of the session so examples are shareable like saved projects are.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExamplesGallery } from '../components/examples/ExamplesGallery';
import { AppHeader } from '../components/layout/AppHeader';
import { useLocalizedHref } from '../i18n/useLocalizedNavigate';
import { useDocumentTitle } from '../utils/useDocumentTitle';
import type { ExampleProject } from '../data/examples';

export const ExamplesPage: React.FC = () => {
  const localize = useLocalizedHref();
  useDocumentTitle('Examples — Velxio');

  const navigate = useNavigate();

  const handleLoadExample = (example: ExampleProject) => {
    navigate(localize(`/example/${example.id}`));
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: '#1e1e1e',
      }}
    >
      <AppHeader />
      <ExamplesGallery onLoadExample={handleLoadExample} />
    </div>
  );
};
