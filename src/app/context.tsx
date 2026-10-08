import { createContext, useContext, type ParentProps } from 'solid-js';
import type { AppServices } from './services';

/**
 * The context stores an accessor rather than the object itself.
 *
 * Services are built once at boot and are not expected to change, but exposing
 * them through a function keeps the context reactive if they are ever replaced
 * (for example by a future "reset library" flow) and avoids reading a reactive
 * prop at a point where updates would be missed.
 */
type ServicesAccessor = () => AppServices;

const AppContext = createContext<ServicesAccessor>();

export function AppProvider(props: ParentProps<{ services: AppServices }>) {
  const services: ServicesAccessor = () => props.services;
  return <AppContext.Provider value={services}>{props.children}</AppContext.Provider>;
}

export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (services === undefined) {
    throw new Error('useApp() was called outside of <AppProvider>.');
  }
  return services();
}
