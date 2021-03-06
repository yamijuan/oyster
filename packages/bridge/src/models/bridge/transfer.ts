import {
  contexts,
  utils,
  programIds,
  WalletAdapter,
  getMultipleAccounts,
  sendTransaction,
  cache,
  TokenAccountParser,
  ParsedAccount,
  formatNumber,
  formatAmount,
  createAssociatedTokenAccountInstruction,
} from '@oyster/common';

import { ethers } from 'ethers';
import { ASSET_CHAIN } from '../../utils/assets';
import { BigNumber } from 'ethers/utils';
import { Erc20Factory } from '../../contracts/Erc20Factory';
import { WormholeFactory } from '../../contracts/WormholeFactory';
import { AssetMeta, createWrappedAssetInstruction } from './meta';
import { bridgeAuthorityKey, wrappedAssetMintKey } from './helpers';
import {
  Account,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { AccountInfo, AccountLayout } from '@solana/spl-token';

export interface ProgressUpdate {
  message: string;
  type: string;
  step: number;
  group: string;
  replace?: boolean;
}

export interface TransferRequestInfo {
  name: string;
  balance: BigNumber;
  decimals: number;
  allowance: BigNumber;
  isWrapped: boolean;
  chainID: number;
  assetAddress: Buffer;
  mint: string;
}

export interface TransferRequest {
  nonce?: number;
  signer?: ethers.Signer;
  asset?: string;
  amount?: number;
  amountBN?: BigNumber;

  recipient?: Buffer;

  info?: TransferRequestInfo;

  from?: ASSET_CHAIN;
  toChain?: ASSET_CHAIN;
}

// type of updates
// 1. info
// 2. user
// 3. wait (progress bar)

export const transfer = async (
  connection: Connection,
  wallet: WalletAdapter,
  request: TransferRequest,
  provider: ethers.providers.Web3Provider,
  setProgress: (update: ProgressUpdate) => void,
) => {
  if (!request.asset) {
    return;
  }

  const walletName = 'MetaMask';
  request.signer = provider?.getSigner();

  request.nonce = await provider.getTransactionCount(
    request.signer.getAddress(),
    'pending',
  );

  let counter = 0;
  // check difference between lock/approve (invoke lock if allowance < amount)
  const steps = {
    transfer: async (request: TransferRequest) => {
      if (!request.info || !request.amount) {
        return;
      }

      request.amountBN = ethers.utils.parseUnits(
        formatAmount(request.amount, 9),
        request.info.decimals,
      );

      return steps.prepare(request);
    },

    // creates wrapped account on solana
    prepare: async (request: TransferRequest) => {
      if (!request.info || !request.from || !wallet.publicKey) {
        return;
      }

      const group = 'Initiate transfer';
      try {
        const bridgeId = programIds().wormhole.pubkey;
        const authority = await bridgeAuthorityKey(bridgeId);
        const meta: AssetMeta = {
          decimals: Math.min(request.info?.decimals, 9),
          address: request.info?.assetAddress,
          chain: request.from,
        };
        const mintKey = await wrappedAssetMintKey(bridgeId, authority, meta);

        const recipientKey =
          cache
            .byParser(TokenAccountParser)
            .map(key => {
              let account = cache.get(key) as ParsedAccount<AccountInfo>;
              if (account?.info.mint.toBase58() === mintKey.toBase58()) {
                return key;
              }

              return;
            })
            .find(_ => _) || '';
        const recipient: PublicKey = recipientKey
          ? new PublicKey(recipientKey)
          : (
              await PublicKey.findProgramAddress(
                [
                  wallet.publicKey.toBuffer(),
                  programIds().token.toBuffer(),
                  mintKey.toBuffer(),
                ],
                programIds().associatedToken,
              )
            )[0];

        request.recipient = recipient.toBuffer();

        const accounts = await getMultipleAccounts(
          connection,
          [mintKey.toBase58(), recipient.toBase58()],
          'single',
        );
        const instructions: TransactionInstruction[] = [];
        const signers: Account[] = [];

        if (!accounts.array[0]) {
          // create mint using wormhole instruction
          instructions.push(
            await createWrappedAssetInstruction(
              meta,
              bridgeId,
              authority,
              mintKey,
              wallet.publicKey,
            ),
          );
        }

        if (!accounts.array[1]) {
          createAssociatedTokenAccountInstruction(
            instructions,
            recipient,
            wallet.publicKey,
            wallet.publicKey,
            mintKey,
          );
        }

        if (instructions.length > 0) {
          setProgress({
            message: 'Waiting for Solana approval...',
            type: 'user',
            group,
            step: counter++,
          });

          const tx = await sendTransaction(
            connection,
            wallet,
            instructions,
            signers,
            true,
          );
        }
      } catch (err) {
        setProgress({
          message: `Couldn't create Solana account!`,
          type: 'error',
          group,
          step: counter++,
        });
        throw err;
      }

      return steps.approve(request);
    },
    // approves assets for transfer
    approve: async (request: TransferRequest) => {
      if (!request.amountBN || !request.asset || !request.signer) {
        return;
      }

      const group = 'Approve assets';
      try {
        if (request.info?.allowance.lt(request.amountBN)) {
          let e = Erc20Factory.connect(request.asset, request.signer);
          setProgress({
            message: `Waiting for ${walletName} approval`,
            type: 'user',
            group,
            step: counter++,
          });
          let res = await e.approve(
            programIds().wormhole.bridge,
            request.amountBN,
          );
          setProgress({
            message: 'Waiting for ETH transaction to be minted...',
            type: 'wait',
            group,
            step: counter++,
          });
          await res.wait(1);
          setProgress({
            message: 'Approval on ETH succeeded!',
            type: 'done',
            group,
            step: counter++,
          });
        } else {
          setProgress({
            message: 'Already approved on ETH!',
            type: 'done',
            group,
            step: counter++,
          });
        }
      } catch (err) {
        setProgress({
          message: 'Approval failed!',
          type: 'error',
          group,
          step: counter++,
        });
        throw err;
      }

      return steps.lock(request);
    },
    // locks assets in the bridge
    lock: async (request: TransferRequest) => {
      if (
        !request.amountBN ||
        !request.asset ||
        !request.signer ||
        !request.recipient ||
        !request.toChain ||
        !request.info ||
        !request.nonce
      ) {
        return;
      }

      let group = 'Lock assets';

      try {
        let wh = WormholeFactory.connect(
          programIds().wormhole.bridge,
          request.signer,
        );
        setProgress({
          message: `Waiting for ${walletName} transfer approval`,
          type: 'user',
          group,
          step: counter++,
        });
        let res = await wh.lockAssets(
          request.asset,
          request.amountBN,
          request.recipient,
          request.toChain,
          request.nonce,
          false,
        );
        setProgress({
          message: 'Waiting for ETH transaction to be minted...',
          type: 'wait',
          group,
          step: counter++,
        });
        await res.wait(1);
        setProgress({
          message: 'Transfer on ETH succeeded!',
          type: 'done',
          group,
          step: counter++,
        });
      } catch (err) {
        setProgress({
          message: 'Transfer failed!',
          type: 'error',
          group,
          step: counter++,
        });
        throw err;
      }

      return steps.wait(request);
    },
    wait: async (request: TransferRequest) => {
      let startBlock = provider.blockNumber;
      let completed = false;
      let group = 'Finalizing transfer';

      const ethConfirmationMessage = (current: number) =>
        `Awaiting ETH confirmations: ${current} out of 15`;

      setProgress({
        message: ethConfirmationMessage(0),
        type: 'wait',
        step: counter++,
        group,
      });

      let blockHandler = (blockNumber: number) => {
        let passedBlocks = blockNumber - startBlock;
        const isLast = passedBlocks === 14;
        if (passedBlocks < 15) {
          setProgress({
            message: ethConfirmationMessage(passedBlocks),
            type: isLast ? 'done' : 'wait',
            step: counter++,
            group,
            replace: passedBlocks > 0,
          });

          if (isLast) {
            setProgress({
              message: 'Awaiting completion on Solana...',
              type: 'wait',
              group,
              step: counter++,
            });
          }
        } else if (!completed) {
          provider.removeListener('block', blockHandler);
        }
      };
      provider.on('block', blockHandler);

      return new Promise<void>((resolve, reject) => {
        if (!request.recipient) {
          return;
        }

        let accountChangeListener = connection.onAccountChange(
          new PublicKey(request.recipient),
          () => {
            if (completed) return;

            completed = true;
            provider.removeListener('block', blockHandler);
            connection.removeAccountChangeListener(accountChangeListener);
            setProgress({
              message: 'Transfer completed on Solana',
              type: 'info',
              group,
              step: counter++,
            });
            resolve();
          },
          'single',
        );
      });
    },
    //
    vaa: async (request: TransferRequest) => {},
  };

  return steps.transfer(request);
};
