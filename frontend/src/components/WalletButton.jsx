import { useWeb3Modal } from '@web3modal/wagmi/react';
import { useAccount, useDisconnect } from 'wagmi';

export function WalletButton() {
  const { open } = useWeb3Modal();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '14px', fontFamily: 'monospace' }}>
          {address?.slice(0, 6)}...{address?.slice(-4)}
        </span>
        <button
          onClick={() => disconnect()}
          style={{
            padding: '8px 16px',
            backgroundColor: 'var(--accent-red, #ef4444)',
            color: 'white',
            border: 'none',
            borderRadius: 'var(--border-radius-sm, 6px)',
            cursor: 'pointer',
            minHeight: '44px',
          }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => open()}
      style={{
        padding: '12px 24px',
        backgroundColor: 'var(--accent, #3b82f6)',
        color: 'white',
        border: 'none',
        borderRadius: 'var(--border-radius-sm, 6px)',
        cursor: 'pointer',
        fontWeight: '600',
        minHeight: '44px',
      }}
    >
      Connect Wallet
    </button>
  );
}