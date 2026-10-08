import { Route, Router } from '@solidjs/router';
import Layout from '~/ui/Layout';
import LibraryView from '~/ui/LibraryView';
import BookDetailsView from '~/ui/BookDetailsView';
import SettingsView from '~/ui/SettingsView';
import NotFoundView from '~/ui/NotFoundView';

export default function App() {
  return (
    <Router root={Layout}>
      <Route path="/" component={LibraryView} />
      <Route path="/book/:id" component={BookDetailsView} />
      <Route path="/settings" component={SettingsView} />
      <Route path="*" component={NotFoundView} />
    </Router>
  );
}
