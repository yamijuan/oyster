import {
  getTokenName,
  getVerboseTokenName,
  KnownTokenMap,
} from '@oyster/common';

export const getAssetName = (
  parsedAssetAddress: string,
  assetChain: number,
  solanaTokens: KnownTokenMap,
  ethTokens: KnownTokenMap,
) => {
  if (assetChain === ASSET_CHAIN.Solana)
    return getVerboseTokenName(solanaTokens, parsedAssetAddress);
  else return getVerboseTokenName(ethTokens, `0x${parsedAssetAddress}`);
};

export const getAssetTokenSymbol = (
  parsedAssetAddress: string,
  assetChain: number,
  solanaTokens: KnownTokenMap,
  ethTokens: KnownTokenMap,
) => {
  if (assetChain === ASSET_CHAIN.Solana)
    return getTokenName(solanaTokens, parsedAssetAddress);
  else return getTokenName(ethTokens, `0x${parsedAssetAddress}`);
};

export const getAssetAmountInUSD = (
  amount: number,
  parsedAssetAddress: string,
  assetChain: number,
) => {
  return amount;
};

export enum ASSET_CHAIN {
  Solana = 1,
  Ethereum = 2,
}
