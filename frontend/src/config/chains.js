import { defineChain } from 'viem';

export const monadMainnet = defineChain({
  id: 143,
  name: 'Monad',
  nativeCurrency: {
    decimals: 18,
    name: 'Monad',
    symbol: 'MON',
  },
  rpcUrls: {
    default: { http: ['https://rpc.monad.xyz'] },
  },
  blockExplorers: {
    default: { 
      name: 'Explorer', 
      url: 'https://monadvision.com' 
    },
  },
  testnet: false,
});

// Legacy alias for any remaining imports
export const monadTestnet = monadMainnet;