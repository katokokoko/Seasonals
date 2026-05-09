import type { Wallet } from "../types/position";

export const fixtureWalletMain: Wallet = {
  wallet_id: "wal_001",
  address: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  label: "Main wallet",
  is_active: true,
  device_binding: {
    device_id: "seeker-emulator-001",
    binding_method: "mwa",
    bound_at: "2026-04-01T00:00:00.000Z",
  },
};

export const fixtureWalletStaking: Wallet = {
  wallet_id: "wal_002",
  address: "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc",
  label: "Staking wallet",
  is_active: true,
  device_binding: null,
};

export const fixtureWalletInactive: Wallet = {
  wallet_id: "wal_003",
  address: "3kFmTpL8wXqRrV9aHzCs2nDgEjYbN7vMxQ5rBoHkPdLi",
  label: "Old wallet (read-only)",
  is_active: false,
  device_binding: null,
};

export const fixtureWallets: Wallet[] = [
  fixtureWalletMain,
  fixtureWalletStaking,
  fixtureWalletInactive,
];
