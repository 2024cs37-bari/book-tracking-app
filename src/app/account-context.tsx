import type { AccountSession } from '~/services/auth-client';
import { createContext, useContext, type Accessor, type ParentProps } from 'solid-js';

export interface AccountActions {
  readonly session: Accessor<AccountSession | null>;
  readonly offline: Accessor<boolean>;
  signOut(): void;
}

const AccountContext = createContext<AccountActions>();
export function AccountProvider(props: ParentProps<{ account: AccountActions }>) {
  return <AccountContext.Provider value={props.account}>{props.children}</AccountContext.Provider>;
}
export function useAccount(): AccountActions | undefined {
  return useContext(AccountContext);
}
