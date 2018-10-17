import config from '../../config';
import { injectable, inject } from 'inversify';
const Web3 = require('web3');
const Web3Utils = require('web3-utils');
const Web3Abi = require('web3-eth-abi');
const net = require('net');
import { getMongoRepository } from 'typeorm';

import {
  Transaction,
  ERC20_TRANSFER,
  TRANSACTION_STATUS_PENDING,
  TRANSACTION_STATUS_CONFIRMED,
  TRANSACTION_STATUS_FAILED,
  ETHEREUM_TRANSFER
} from '../../entities/transaction';
import { TransactionRepositoryInterface, TransactionRepositoryType } from '../repositories/transaction.repository';
import { chunkArray, processAsyncItemsByChunks, processAsyncIntRangeByChunks } from '../../helpers/helpers';
import { Logger } from '../../logger';
import { UserRepositoryType, UserRepositoryInterface } from '../repositories/user.repository';
import { Wallet } from '../../entities/wallet';
import { Transaction as EthTransaction, Block } from 'web3/types';
import { toEthChecksumAddress } from '../crypto';

type WalletsMap = { [k: string]: Wallet[] };
type ExtEthTransaction = EthTransaction & {
  contractAddress: string;
};

export interface Web3EventInterface {
}

/* istanbul ignore next */
function getTxStatusByReceipt(receipt: any): string {
  if (!receipt) {
    return TRANSACTION_STATUS_PENDING;
  }
  if (receipt.status === '0x1') {
    return TRANSACTION_STATUS_CONFIRMED;
  }
  return TRANSACTION_STATUS_FAILED;
}

const CONCURRENT_BLOCK_PROCESS_COUNT = 3;
const CONCURRENT_TRANSACTIONS_PROCESS_COUNT = 4;
const TRANSACTION_CHECKING_INTERVAL_TIME: number = 15000;

/* istanbul ignore next */
// @TODO: Need to refacoring and test cover
@injectable()
export class Web3Event implements Web3EventInterface {
  private logger = Logger.getInstance('WEB3_EVENT');
  private web3: any;
  private lastCheckingBlock: number = 0;

  private erc20Abi: {
    Events: {
      Transfer: {
        abi: any;
      }
    },
    transfer: {
      methodSignature: string;
      abi: any;
    },
    transferFrom: {
      methodSignature: string;
      abi: any;
    }
  };

  /**
   *
   * @param txRep
   */
  constructor(
    @inject(TransactionRepositoryType) private txRep: TransactionRepositoryInterface,
    @inject(UserRepositoryType) private userRep: UserRepositoryInterface
  ) {
    // @TODO: Need to rewrite this, to use library to get signature from abi
    this.erc20Abi = {
      Events: {
        Transfer: {
          abi: config.contracts.erc20Token.abi.filter(i => i.type === 'event' && i.name === 'Transfer').pop()
        }
      },
      transfer: {
        methodSignature: Web3Abi.encodeFunctionSignature('transfer(address,uint256)').slice(2),
        abi: config.contracts.erc20Token.abi.filter(i => i.type === 'function' && i.name === 'transfer').pop()
      },
      transferFrom: {
        methodSignature: Web3Abi.encodeFunctionSignature('transferFrom(address,uint256,uint256)').slice(2),
        abi: config.contracts.erc20Token.abi.filter(i => i.type === 'function' && i.name === 'transferFrom').pop()
      }
    };

    switch (config.web3.type) {
      case 'ipc':
        this.web3 = new Web3(new Web3.providers.IpcProvider(config.web3.address, net));
        break;

      case 'ws':
        const webSocketProvider = new Web3.providers.WebsocketProvider(config.web3.address);

        webSocketProvider.connection.onclose = () => {
          this.logger.info('Web3 socket connection closed');
          this.onWsClose();
        };

        this.web3 = new Web3(webSocketProvider);
        break;

      case 'http':
        this.web3 = new Web3(config.web3.address);
        break;

      default:
        throw Error('Unknown Web3 RPC type!');
    }

    if (config.web3.type !== 'http') {
      this.attachEvents();
    }

    this.initDeferredTransactionsChecking();
  }

  /**
   *
   */
  private initDeferredTransactionsChecking() {
    this.logger.debug('[initDeferredTransactionsChecking]');

    const intervalExecuteMethod = () => {
      setTimeout(() => {
        this.checkTransactions()
          .then((a) => { return a; }, (err) => { this.logger.error('[initDeferredTransactionsChecking] Error was occurred', { error: err }); })
          .then(() => { intervalExecuteMethod(); });
      }, TRANSACTION_CHECKING_INTERVAL_TIME);
    };

    intervalExecuteMethod();
  }

  /**
   *
   * @param blockData
   */
  private async getWalletMapInTransactions(transactions: ExtEthTransaction[]): Promise<WalletsMap> {
    const txMaps = {};
    transactions.map(t => t.from).concat(transactions.map(t => t.to)).filter(t => t)
      .forEach(t => {
        txMaps[t] = 1;
      });

    const walletIds = {};
    (await this.userRep.getAllByWalletAddresses(
      Object.keys(txMaps)
    )).map(u => u.wallets)
      .reduce((allWallets, wallets) => allWallets.concat(wallets), [])
      .filter(w => txMaps[w.address])
      .forEach(w => {
        walletIds[w.address] = (walletIds[w.address] || []);
        walletIds[w.address].push(w);
      });

    return walletIds;
  }

  private filterTransactionByWalletAddresses(walletsMap: WalletsMap, transactions: ExtEthTransaction[]): ExtEthTransaction[] {
    return transactions
      .filter(t => walletsMap[t.from] || walletsMap[t.to]);
  }

  /**
   *
   */
  async checkTransactions(): Promise<boolean> {
    const logger = this.logger.sub(null, '[checkTransactions] ');
    logger.debug('Check transactions in blocks');

    if (!this.lastCheckingBlock) {
      logger.debug('Get the biggest block height value from local transactions');

      const txWithMaxBlockHeight = await getMongoRepository(Transaction).find({
        order: {
          blockNumber: -1
        },
        take: 1
      });

      this.lastCheckingBlock = Math.max(
        (txWithMaxBlockHeight.length && txWithMaxBlockHeight.pop().blockNumber || 0) - 4,
        config.web3.startBlock
      );
    }

    const currentBlock = await this.web3.eth.getBlockNumber();
    if (!this.lastCheckingBlock) {
      this.lastCheckingBlock = currentBlock - 4;
    }

    logger.debug('Check blocks from', this.lastCheckingBlock, 'to', currentBlock);

    await processAsyncIntRangeByChunks(this.lastCheckingBlock, currentBlock, 1, CONCURRENT_BLOCK_PROCESS_COUNT, async (i) => {
      const blockData: Block = await this.web3.eth.getBlock(i, true);

      if (!(i % 10)) {
        logger.debug('Blocks processed:', i);
      }

      if (!blockData) {
        return;
      }

      try {
        await this.processTransactionsInBlock(blockData);
      } catch (err) {
        logger.error(err);
      }
    });

    this.lastCheckingBlock = currentBlock - 10;
    logger.debug('Change lastCheckingBlock to', this.lastCheckingBlock);

    return true;
  }

  /**
   *
   * @param data
   */
  async processNewBlockHeaders(data: any): Promise<void> {
    if (!data.number) {
      // skip pending blocks
      return;
    }

    this.logger.debug('[processNewBlockHeaders]', { meta: { blockNumber: data.number } });

    this.processTransactionsInBlock(await this.web3.eth.getBlock(data.hash, true));
  }

  /**
   *
   * @param blockData
   */
  private async processTransactionsInBlock(blockData: Block) {
    if (!blockData || !blockData.transactions || !blockData.transactions.length) {
      return {};
    }

    // extend transactions in block by parsing erc20 methods
    const sourceTransactions: ExtEthTransaction[] = blockData.transactions.map(t => {
      let contractAddress = undefined;
      if (t.input.length === 2 + 8 + 64 + 64 && t.input.slice(2, 10) === this.erc20Abi.transfer.methodSignature) {
        contractAddress = t.to;
        const methodArgs = Web3Abi.decodeParameters(this.erc20Abi.transfer.abi.inputs, t.input.slice(10));
        t.from = t.from;
        t.to = methodArgs[0];
        t.value = methodArgs[1];
      } else if (t.input.length === 2 + 8 + 64 + 64 + 64 && t.input.slice(2, 10) === this.erc20Abi.transfer.methodSignature) {
        contractAddress = t.to;
        const methodArgs = Web3Abi.decodeParameters(this.erc20Abi.transferFrom.abi.inputs, t.input.slice(10));
        t.from = methodArgs[0];
        t.to = methodArgs[1];
        t.value = methodArgs[2];
      }
      return {
        ...t,
        contractAddress
      };
    });

    const wallets = await this.getWalletMapInTransactions(sourceTransactions);
    if (!Object.keys(wallets).length) {
      return;
    }

    const transactions = this.filterTransactionByWalletAddresses(wallets, sourceTransactions);

    this.logger.debug('[processTransactionsInBlock] Process transactions in block', transactions.length, 'wallets count', Object.keys(wallets).length);

    await processAsyncItemsByChunks(transactions || [], CONCURRENT_TRANSACTIONS_PROCESS_COUNT,
      transaction => this.processTransaction(transaction, blockData, wallets));
  }

  private processNotRegisteredEthereumTransaction(tx: Transaction, ethTx: ExtEthTransaction) {
    tx.type = ETHEREUM_TRANSFER;
    delete tx.contractAddress;
    tx.from = ethTx.from;
    tx.to = ethTx.to;
    tx.amount = Web3Utils.fromWei(ethTx.value);
  }

  private processNotRegisteredContractTransaction(tx: Transaction, ethTx: ExtEthTransaction): boolean {
    const methodSignature = ethTx.input.slice(2, 10);

    if (methodSignature === this.erc20Abi.transfer.methodSignature) {
      tx.from = ethTx.from;
      tx.to = ethTx.to;
      tx.amount = ethTx.value;
    } else if (methodSignature === this.erc20Abi.transfer.methodSignature) {
      tx.from = ethTx.from;
      tx.to = ethTx.to;
      tx.amount = ethTx.value;
    } else {
      return false;
    }

    tx.type = ERC20_TRANSFER;
    tx.contractAddress = ethTx.contractAddress;

    return true;
  }

  /**
   *
   * @param data
   */
  async processTransaction(ethTx: ExtEthTransaction, blockData: Block, walletsMap: WalletsMap): Promise<void> {
    let tx = await this.txRep.getByHash(ethTx.hash);
    // process for not registered tx-s
    if (!tx) {
      tx = Transaction.createTransaction({
        transactionHash: ethTx.hash,
        details: JSON.stringify({
          gas: ethTx.gas,
          gasPrice: Web3Utils.fromWei(ethTx.gasPrice, 'gwei')
        })
      });
      if (ethTx.value && ethTx.input === '0x') {
        this.logger.debug('Process a new ethereum transfer transaction', ethTx.hash);
        this.processNotRegisteredEthereumTransaction(tx, ethTx);
      } else {
        this.logger.debug('Process a new contract transaction', ethTx.hash);
        if (!this.processNotRegisteredContractTransaction(tx, ethTx)) {
          this.logger.debug('Unknown contract action in transaction, skip this', ethTx.hash);
          return;
        }
      }
    } else if (tx.status !== TRANSACTION_STATUS_PENDING) {
      return;
    }

    this.logger.debug('Check status of transaction', ethTx.hash);

    const transactionReceipt = await this.web3.eth.getTransactionReceipt(ethTx.hash);
    if (!transactionReceipt) {
      return;
    }

    blockData = blockData || await this.web3.eth.getBlock(ethTx.blockNumber);

    tx.status = getTxStatusByReceipt(transactionReceipt);

    // check erc20 Transfer event
    if (tx.status !== TRANSACTION_STATUS_FAILED && tx.type === ERC20_TRANSFER) {
      tx.status = TRANSACTION_STATUS_FAILED;
      if (!transactionReceipt.logs.length) {
        this.logger.warn('No events was raised, perhaps insufficient tokens or not allowed withdrawal for', ethTx.hash);
      } else {
        transactionReceipt.logs.forEach(log => {
          const decodedLogs = Web3Abi.decodeLog(this.erc20Abi.Events.Transfer.abi.inputs, log.data, log.topics);
          if (decodedLogs && decodedLogs._from && decodedLogs._to) {
            tx.status = TRANSACTION_STATUS_CONFIRMED;
          }
        });
        if (tx.status !== TRANSACTION_STATUS_CONFIRMED) {
          this.logger.warn('Wrong logs in transaction receipt', ethTx.hash, transactionReceipt.logs);
        }
      }
    }

    tx.timestamp = blockData.timestamp;
    tx.blockNumber = blockData.number;

    this.logger.debug('Save processed transaction', tx);

    await this.txRep.save(tx);
  }

  /**
   *
   */
  onWsClose() {
    this.logger.error('Web3 socket connection closed. Trying to reconnect');
    const webSocketProvider = new Web3.providers.WebsocketProvider(config.web3.address);
    webSocketProvider.connection.onclose = () => {
      this.logger.info('Web3 socket connection closed');
      setTimeout(() => {
        this.onWsClose();
      }, config.web3.reconnectTimeout);
    };

    this.web3.setProvider(webSocketProvider);
    this.attachEvents();
  }

  /**
   *
   */
  attachEvents() {
    this.logger.debug('Attach to ethereum realtime events');

    // process new blocks
    this.web3.eth.subscribe('newBlockHeaders')
      .on('data', (data) => this.processNewBlockHeaders(data));

    // process pending transactions
    // this.web3.eth.subscribe('pendingTransactions')
    //   .on('data', (txHash) => this.processTransaction(txHash, null, {}));
  }
}

const Web3EventType = Symbol('Web3EventInterface');

export { Web3EventType };
