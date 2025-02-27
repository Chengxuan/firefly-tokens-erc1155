// Copyright © 2021 Kaleido, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { ClientRequest } from 'http';
import { HttpService } from '@nestjs/axios';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import { abi as ERC1155MixedFungibleAbi } from '../abi/ERC1155MixedFungible.json';
import { EventStreamService } from '../event-stream/event-stream.service';
import { Event, EventStream, EventStreamReply } from '../event-stream/event-stream.interfaces';
import { EventStreamProxyGateway } from '../eventstream-proxy/eventstream-proxy.gateway';
import { EventListener, EventProcessor } from '../eventstream-proxy/eventstream-proxy.interfaces';
import { WebSocketMessage } from '../websocket-events/websocket-events.base';
import { basicAuth } from '../utils';
import {
  ApprovalForAllEvent,
  AsyncResponse,
  ContractInfoResponse,
  EthConnectAsyncResponse,
  EthConnectReturn,
  IAbiMethod,
  TokenApproval,
  TokenApprovalEvent,
  TokenBalance,
  TokenBalanceQuery,
  TokenBurn,
  TokenBurnEvent,
  TokenPoolCreationEvent,
  TokenMint,
  TokenMintEvent,
  TokenPool,
  TokenPoolActivate,
  TokenPoolEvent,
  TokenTransfer,
  TokenTransferEvent,
  TokenType,
  TransferBatchEvent,
  TransferSingleEvent,
  TokenPoolEventInfo,
} from './tokens.interfaces';
import {
  decodeHex,
  encodeHex,
  encodeHexIDForURI,
  isFungible,
  packPoolLocator,
  packStreamName,
  packSubscriptionName,
  packTokenId,
  unpackPoolLocator,
  unpackSubscriptionName,
  unpackTokenId,
} from './tokens.util';

const TOKEN_STANDARD = 'ERC1155';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const BASE_SUBSCRIPTION_NAME = 'base';
const CUSTOM_URI_IID = '0xa1d87d57';

const sendTransactionHeader = 'SendTransaction';
const queryHeader = 'Query';
const tokenCreateFunctionName = 'create';
const tokenCreateEvent = 'TokenPoolCreation';
const tokenCreateEventSignatureOld = 'TokenCreate(address,uint256,bytes)';
const tokenCreateEventSignature = 'TokenPoolCreation(address,uint256,bytes)';
const transferSingleEvent = 'TransferSingle';
const transferSingleEventSignature = 'TransferSingle(address,address,address,uint256,uint256)';
const transferBatchEvent = 'TransferBatch';
const transferBatchEventSignature = 'TransferBatch(address,address,address,uint256[],uint256[])';
const approvalForAllEvent = 'ApprovalForAll';
const approvalForAllEventSignature = 'ApprovalForAll(address,address,bool)';

const ALL_SUBSCRIBED_EVENTS = [
  tokenCreateEvent,
  transferSingleEvent,
  transferBatchEvent,
  approvalForAllEvent,
];

@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);
  private contractAddress: string;
  private supportsCustomUri: boolean;

  baseUrl: string;
  instancePath: string;
  instanceUrl: string;
  topic: string;
  shortPrefix: string;
  stream: EventStream | undefined;
  username: string;
  password: string;

  constructor(
    private http: HttpService,
    private eventstream: EventStreamService,
    private proxy: EventStreamProxyGateway,
  ) {}

  configure(
    baseUrl: string,
    instancePath: string,
    topic: string,
    shortPrefix: string,
    username: string,
    password: string,
    contractAddress: string,
  ) {
    this.baseUrl = baseUrl;
    this.instancePath = instancePath;
    this.instanceUrl = new URL(this.instancePath, this.baseUrl).href;
    this.topic = topic;
    this.shortPrefix = shortPrefix;
    this.username = username;
    this.password = password;
    this.contractAddress = contractAddress.toLowerCase();
    this.proxy.addConnectionListener(this);
    this.proxy.addEventListener(new TokenListener(this));
  }

  async onConnect() {
    const wsUrl = new URL('/ws', this.baseUrl.replace('http', 'ws')).href;
    const stream = await this.getStream();
    this.proxy.configure(wsUrl, stream.name);
  }

  /**
   * One-time initialization of event stream and base subscription.
   */
  async init() {
    const stream = await this.getStream();

    const eventABI = ERC1155MixedFungibleAbi.find(m => m.name === tokenCreateEvent);
    const methodABI = ERC1155MixedFungibleAbi.find(m => m.name === tokenCreateFunctionName);

    if (eventABI !== undefined && methodABI !== undefined) {
      const contractAddress = await this.getContractAddress();
      await this.eventstream.getOrCreateSubscription(
        this.baseUrl,
        eventABI,
        stream.id,
        tokenCreateEvent,
        packSubscriptionName(this.instancePath, BASE_SUBSCRIPTION_NAME, tokenCreateEvent),
        contractAddress,
        [methodABI],
        '0',
      );
    }
  }

  private async getContractAddress() {
    if (!this.contractAddress) {
      this.logger.debug(
        `CONTRACT_ADDRESS is not set, fetching the address using instance url: ${this.instanceUrl}`,
      );
      const response = await this.wrapError(
        lastValueFrom(
          this.http.get<ContractInfoResponse>(this.instanceUrl, {
            ...basicAuth(this.username, this.password),
          }),
        ),
      );
      this.contractAddress = '0x' + response.data.address.toLowerCase();
      this.logger.debug(`Contract address: ${this.contractAddress}`);
    }

    return this.contractAddress;
  }

  async isCustomUriSupported() {
    if (this.supportsCustomUri === undefined) {
      try {
        const result = await this.query(
          ERC1155MixedFungibleAbi.find(m => m.name === 'supportsInterface'),
          [CUSTOM_URI_IID],
        );
        this.logger.debug(
          `Result for URI support on instance '${this.instancePath}': ${result.output}`,
        );
        this.supportsCustomUri = result.output === true;
      } catch (err) {
        this.logger.log(
          `Failed to query URI support on instance '${this.instancePath}': assuming false`,
        );
        this.supportsCustomUri = false;
      }
    }
    return this.supportsCustomUri;
  }

  async queryBaseUri() {
    try {
      const result = await this.query(
        ERC1155MixedFungibleAbi.find(m => m.name === 'baseTokenUri'),
        [CUSTOM_URI_IID],
      );
      return result.output as string;
    } catch (err) {
      this.logger.error(`Failed to query base URI`);
      return '';
    }
  }

  private async getStream() {
    const stream = this.stream;
    if (stream !== undefined) {
      return stream;
    }
    await this.migrationCheck();
    const name = this.stream?.name ?? packStreamName(this.topic, this.instancePath);
    this.logger.log('Creating stream with name ' + name);
    this.stream = await this.eventstream.createOrUpdateStream(name, name);
    return this.stream;
  }

  /**
   * Check for existing event streams and subscriptions that don't match the current
   * expected format (ie incorrect names, missing event subscriptions).
   *
   * Log a warning if any potential issues are flagged. User may need to delete
   * subscriptions manually and reactivate the pool directly.
   */
  async migrationCheck() {
    const name = packStreamName(this.topic, this.instancePath);
    const streams = await this.eventstream.getStreams();
    let existingStream = streams.find(s => s.name === name);
    if (existingStream === undefined) {
      // Look for the old stream name (topic alone)
      existingStream = streams.find(s => s.name === this.topic);
      if (existingStream === undefined) {
        return false;
      }
      this.logger.warn(
        `Old event stream found with name ${existingStream.name}. ` +
          `The connector will continue to use this stream, but it is recommended ` +
          `to create a new stream with the name ${name}.`,
      );
    }
    this.stream = existingStream;
    const streamId = existingStream.id;

    const allSubscriptions = await this.eventstream.getSubscriptions();
    const subscriptions = allSubscriptions.filter(s => s.stream === streamId);
    if (subscriptions.length === 0) {
      return false;
    }

    const baseSubscription = packSubscriptionName(
      this.instancePath,
      BASE_SUBSCRIPTION_NAME,
      tokenCreateEvent,
    );

    const foundEvents = new Map<string, string[]>();
    for (const sub of subscriptions) {
      if (sub.name === baseSubscription) {
        continue;
      }
      const parts = unpackSubscriptionName(sub.name);
      if (parts.poolLocator === undefined || parts.event === undefined) {
        this.logger.warn(
          `Non-parseable subscription name '${sub.name}' found in event stream '${existingStream.name}'.` +
            `It is recommended to delete all subscriptions and activate all pools again.`,
        );
        return true;
      }
      const key = packSubscriptionName(parts.instancePath, parts.poolLocator, '', parts.poolData);
      const existing = foundEvents.get(key);
      if (existing !== undefined) {
        existing.push(parts.event);
      } else {
        foundEvents.set(key, [parts.event]);
      }
    }

    // Expect to have found subscriptions for each of the events.
    for (const [key, events] of foundEvents) {
      const parts = unpackSubscriptionName(key);
      if (
        ALL_SUBSCRIBED_EVENTS.length !== events.length ||
        !ALL_SUBSCRIBED_EVENTS.every(event => events.includes(event))
      ) {
        this.logger.warn(
          `Event stream subscriptions for pool ${parts.poolLocator} do not include all expected events ` +
            `(${ALL_SUBSCRIBED_EVENTS}). Events may not be properly delivered to this pool. ` +
            `It is recommended to delete its subscriptions and activate the pool again.`,
        );
        return true;
      }
    }
    return false;
  }

  private requestOptions(): AxiosRequestConfig {
    return basicAuth(this.username, this.password);
  }

  private postOptions(signer: string, requestId?: string) {
    const from = `${this.shortPrefix}-from`;
    const sync = `${this.shortPrefix}-sync`;
    const id = `${this.shortPrefix}-id`;

    const requestOptions: AxiosRequestConfig = {
      params: {
        [from]: signer,
        [sync]: 'false',
        [id]: requestId,
      },
      ...basicAuth(this.username, this.password),
    };

    return requestOptions;
  }
  private async wrapError<T>(response: Promise<AxiosResponse<T>>) {
    return response.catch(err => {
      if (axios.isAxiosError(err)) {
        const request: ClientRequest | undefined = err.request;
        const response: AxiosResponse | undefined = err.response;
        const errorMessage = response?.data?.error ?? err.message;
        this.logger.warn(
          `${request?.path} <-- HTTP ${response?.status} ${response?.statusText}: ${errorMessage}`,
        );
        throw new InternalServerErrorException(errorMessage);
      }
      throw err;
    });
  }

  async query(method?: IAbiMethod, params?: any[]) {
    const response = await this.wrapError(
      lastValueFrom(
        this.http.post<EthConnectReturn>(
          this.baseUrl,
          { headers: { type: queryHeader }, to: await this.getContractAddress(), method, params },
          this.requestOptions(),
        ),
      ),
    );
    return response.data;
  }

  async sendTransaction(from: string, id?: string, method?: IAbiMethod, params?: any[]) {
    const response = await this.wrapError(
      lastValueFrom(
        this.http.post<EthConnectAsyncResponse>(
          this.baseUrl,
          {
            headers: { id, type: sendTransactionHeader },
            from,
            to: await this.getContractAddress(),
            method,
            params,
          },
          this.requestOptions(),
        ),
      ),
    );
    return response.data;
  }

  async getReceipt(id: string): Promise<EventStreamReply> {
    const response = await this.wrapError(
      lastValueFrom(
        this.http.get<EventStreamReply>(new URL(`/reply/${id}`, this.baseUrl).href, {
          validateStatus: status => status < 300 || status === 404,
          ...basicAuth(this.username, this.password),
        }),
      ),
    );
    if (response.status === 404) {
      throw new NotFoundException();
    }
    return response.data;
  }

  async createPool(dto: TokenPool): Promise<AsyncResponse> {
    const response = await this.sendTransaction(
      dto.signer,
      dto.requestId,
      ERC1155MixedFungibleAbi.find(m => m.name === tokenCreateFunctionName),
      [dto.type === TokenType.FUNGIBLE, encodeHex(dto.data ?? '')],
    );
    return { id: response.id };
  }

  async activatePool(dto: TokenPoolActivate) {
    const stream = await this.getStream();
    const poolLocator = unpackPoolLocator(dto.poolLocator);

    const tokenCreateEventABI = ERC1155MixedFungibleAbi.find(m => m.name === tokenCreateEvent);
    const tokenCreateFunctionABI = ERC1155MixedFungibleAbi.find(
      m => m.name === tokenCreateFunctionName,
    );
    const transferSingleEventABI = ERC1155MixedFungibleAbi.find(
      m => m.name === transferSingleEvent,
    );
    const transferBatchEventABI = ERC1155MixedFungibleAbi.find(m => m.name === transferBatchEvent);
    const transferFunctionABIs = ERC1155MixedFungibleAbi.filter(
      m =>
        m.name !== undefined &&
        (m.name.toLowerCase().includes('mint') ||
          m.name.toLowerCase().includes('transfer') ||
          m.name.toLowerCase().includes('burn')),
    );
    const approvalForAllEventABI = ERC1155MixedFungibleAbi.find(
      m => m.name === approvalForAllEvent,
    );
    const approvalFunctionABIs = ERC1155MixedFungibleAbi.filter(m =>
      m.name?.toLowerCase().includes('approval'),
    );

    if (
      tokenCreateEventABI !== undefined &&
      tokenCreateFunctionABI !== undefined &&
      transferSingleEventABI !== undefined &&
      transferBatchEventABI !== undefined &&
      approvalForAllEventABI !== undefined
    ) {
      const contractAddress = await this.getContractAddress();
      await Promise.all([
        this.eventstream.getOrCreateSubscription(
          this.baseUrl,
          tokenCreateEventABI,
          stream.id,
          tokenCreateEvent,
          packSubscriptionName(this.instancePath, dto.poolLocator, tokenCreateEvent, dto.poolData),
          contractAddress,
          [tokenCreateFunctionABI],
          poolLocator.blockNumber ?? '0',
        ),
        this.eventstream.getOrCreateSubscription(
          this.baseUrl,
          transferSingleEventABI,
          stream.id,
          transferSingleEvent,
          packSubscriptionName(
            this.instancePath,
            dto.poolLocator,
            transferSingleEvent,
            dto.poolData,
          ),
          contractAddress,
          transferFunctionABIs,
          poolLocator.blockNumber ?? '0',
        ),
        this.eventstream.getOrCreateSubscription(
          this.baseUrl,
          transferBatchEventABI,
          stream.id,
          transferBatchEvent,
          packSubscriptionName(
            this.instancePath,
            dto.poolLocator,
            transferBatchEvent,
            dto.poolData,
          ),
          contractAddress,
          transferFunctionABIs,
          poolLocator.blockNumber ?? '0',
        ),
        this.eventstream.getOrCreateSubscription(
          this.baseUrl,
          approvalForAllEventABI,
          stream.id,
          approvalForAllEvent,
          packSubscriptionName(
            this.instancePath,
            dto.poolLocator,
            approvalForAllEvent,
            dto.poolData,
          ),
          contractAddress,
          approvalFunctionABIs,
          // Block number is 0 because it is important to receive all approval events,
          // so existing approvals will be reflected in the newly created pool
          '0',
        ),
      ]);
    }
  }

  async mint(dto: TokenMint): Promise<AsyncResponse> {
    const poolLocator = unpackPoolLocator(dto.poolLocator);
    const typeId = packTokenId(poolLocator.poolId);
    if (isFungible(poolLocator.poolId)) {
      const response = await this.sendTransaction(
        dto.signer,
        dto.requestId,
        ERC1155MixedFungibleAbi.find(m => m.name === 'mintFungible'),
        [typeId, [dto.to], [dto.amount], encodeHex(dto.data ?? '')],
      );
      return { id: response.id };
    } else {
      // In the case of a non-fungible token:
      // - We parse the value as a whole integer count of NFTs to mint
      // - We require the number to be small enough to express as a JS number (we're packing into an array)
      const to: string[] = [];
      const amount = parseInt(dto.amount);
      for (let i = 0; i < amount; i++) {
        to.push(dto.to);
      }

      if (dto.uri !== undefined && (await this.isCustomUriSupported())) {
        const response = await this.sendTransaction(
          dto.signer,
          dto.requestId,
          ERC1155MixedFungibleAbi.find(m => m.name === 'mintNonFungibleWithURI'),
          [typeId, to, encodeHex(dto.data ?? ''), dto.uri],
        );
        return { id: response.id };
      } else {
        const response = await this.sendTransaction(
          dto.signer,
          dto.requestId,
          ERC1155MixedFungibleAbi.find(m => m.name === 'mintNonFungible'),
          [typeId, to, encodeHex(dto.data ?? '')],
        );
        return { id: response.id };
      }
    }
  }

  async approval(dto: TokenApproval): Promise<AsyncResponse> {
    const response = await this.sendTransaction(
      dto.signer,
      dto.requestId,
      ERC1155MixedFungibleAbi.find(m => m.name === 'setApprovalForAllWithData'),
      [dto.operator, dto.approved, encodeHex(dto.data ?? '')],
    );
    return { id: response.id };
  }

  async transfer(dto: TokenTransfer): Promise<AsyncResponse> {
    const poolLocator = unpackPoolLocator(dto.poolLocator);
    const response = await this.sendTransaction(
      dto.signer,
      dto.requestId,
      ERC1155MixedFungibleAbi.find(m => m.name === 'safeTransferFrom'),
      [
        dto.from,
        dto.to,
        packTokenId(poolLocator.poolId, dto.tokenIndex),
        dto.amount,
        encodeHex(dto.data ?? ''),
      ],
    );
    return { id: response.id };
  }

  async burn(dto: TokenBurn): Promise<AsyncResponse> {
    const poolLocator = unpackPoolLocator(dto.poolLocator);
    const response = await this.sendTransaction(
      dto.signer,
      dto.requestId,
      ERC1155MixedFungibleAbi.find(m => m.name === 'burn'),
      [
        dto.from,
        packTokenId(poolLocator.poolId, dto.tokenIndex),
        dto.amount,
        encodeHex(dto.data ?? ''),
      ],
    );

    return { id: response.id };
  }

  async balance(dto: TokenBalanceQuery): Promise<TokenBalance> {
    const poolLocator = unpackPoolLocator(dto.poolLocator);
    const response = await this.query(
      ERC1155MixedFungibleAbi.find(m => m.name === 'balanceOf'),
      [dto.account, packTokenId(poolLocator.poolId, dto.tokenIndex)],
    );
    return { balance: response.output };
  }
}

class TokenListener implements EventListener {
  private readonly logger = new Logger(TokenListener.name);

  constructor(private readonly service: TokensService) {}

  async onEvent(subName: string, event: Event, process: EventProcessor) {
    switch (this.trimEventSignature(event.signature)) {
      case tokenCreateEventSignatureOld:
      case tokenCreateEventSignature:
        process(await this.transformTokenPoolCreationEvent(subName, event));
        break;
      case transferSingleEventSignature:
        process(await this.transformTransferSingleEvent(subName, event));
        break;
      case approvalForAllEventSignature:
        process(this.transformApprovalForAllEvent(subName, event));
        break;
      case transferBatchEventSignature:
        for (const msg of await this.transformTransferBatchEvent(subName, event)) {
          process(msg);
        }
        break;
      default:
        this.logger.error(`Unknown event signature: ${event.signature}`);
        return undefined;
    }
  }

  /**
   * Generate an event ID in the recognized FireFly format for Ethereum
   * (zero-padded block number, transaction index, and log index)
   */
  private formatBlockchainEventId(event: Event) {
    const blockNumber = event.blockNumber ?? '0';
    const txIndex = BigInt(event.transactionIndex).toString(10);
    const logIndex = event.logIndex ?? '0';
    return [
      blockNumber.padStart(12, '0'),
      txIndex.padStart(6, '0'),
      logIndex.padStart(6, '0'),
    ].join('/');
  }

  private stripParamsFromSignature(signature: string) {
    return signature.substring(0, signature.indexOf('('));
  }

  private trimEventSignature(signature: string) {
    const firstColon = signature.indexOf(':');
    if (firstColon > 0) {
      return signature.substring(firstColon + 1);
    }
    return signature;
  }

  private async transformTokenPoolCreationEvent(
    subName: string,
    event: TokenPoolCreationEvent,
  ): Promise<WebSocketMessage | undefined> {
    const { data: output } = event;
    const unpackedId = unpackTokenId(output.type_id);
    const unpackedSub = unpackSubscriptionName(subName);
    const decodedData = decodeHex(output.data ?? '');

    if (unpackedSub.poolLocator === undefined) {
      // should not happen
      return undefined;
    }

    const poolLocator = unpackPoolLocator(unpackedSub.poolLocator);
    if (poolLocator.poolId !== BASE_SUBSCRIPTION_NAME && poolLocator.poolId !== unpackedId.poolId) {
      return undefined;
    }

    const eventInfo: TokenPoolEventInfo = {
      address: event.address,
      typeId: '0x' + encodeHexIDForURI(output.type_id),
    };

    if (await this.service.isCustomUriSupported()) {
      eventInfo.baseUri = await this.service.queryBaseUri();
    }

    return {
      event: 'token-pool',
      data: <TokenPoolEvent>{
        standard: TOKEN_STANDARD,
        poolLocator: packPoolLocator(unpackedId.poolId, event.blockNumber),
        type: unpackedId.isFungible ? TokenType.FUNGIBLE : TokenType.NONFUNGIBLE,
        signer: output.operator,
        data: decodedData,
        info: eventInfo,
        blockchain: {
          id: this.formatBlockchainEventId(event),
          name: this.stripParamsFromSignature(this.trimEventSignature(event.signature)),
          location: 'address=' + event.address,
          signature: this.trimEventSignature(event.signature),
          timestamp: event.timestamp,
          output,
          info: {
            blockNumber: event.blockNumber,
            transactionIndex: event.transactionIndex,
            transactionHash: event.transactionHash,
            logIndex: event.logIndex,
            address: event.address,
            signature: this.trimEventSignature(event.signature),
          },
        },
      },
    };
  }

  private async transformTransferSingleEvent(
    subName: string,
    event: TransferSingleEvent,
    eventIndex?: number,
  ): Promise<WebSocketMessage | undefined> {
    const { data: output } = event;
    const unpackedId = unpackTokenId(output.id);
    const unpackedSub = unpackSubscriptionName(subName);
    const decodedData = decodeHex(event.inputArgs?.data ?? '');

    if (unpackedSub.poolLocator === undefined) {
      // should not happen
      return undefined;
    }

    const poolLocator = unpackPoolLocator(unpackedSub.poolLocator);
    if (poolLocator.poolId !== unpackedId.poolId) {
      // this transfer is not from the subscribed pool
      return undefined;
    }
    if (output.from === ZERO_ADDRESS && output.to === ZERO_ADDRESS) {
      // should not happen
      return undefined;
    }

    const uri = unpackedId.isFungible ? undefined : await this.getTokenUri(output.id);
    const eventId = this.formatBlockchainEventId(event);
    const transferId =
      eventIndex === undefined ? eventId : eventId + '/' + eventIndex.toString(10).padStart(6, '0');

    const commonData = <TokenTransferEvent>{
      id: transferId,
      poolData: unpackedSub.poolData,
      poolLocator: unpackedSub.poolLocator,
      tokenIndex: unpackedId.tokenIndex,
      uri,
      amount: output.value,
      signer: output.operator,
      data: decodedData,
      blockchain: {
        id: eventId,
        name: this.stripParamsFromSignature(this.trimEventSignature(event.signature)),
        location: 'address=' + event.address,
        signature: this.trimEventSignature(event.signature),
        timestamp: event.timestamp,
        output,
        info: {
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
          address: event.address,
          signature: this.trimEventSignature(event.signature),
        },
      },
    };

    if (output.from === ZERO_ADDRESS) {
      return {
        event: 'token-mint',
        data: <TokenMintEvent>{ ...commonData, to: output.to },
      };
    } else if (output.to === ZERO_ADDRESS) {
      return {
        event: 'token-burn',
        data: <TokenBurnEvent>{ ...commonData, from: output.from },
      };
    } else {
      return {
        event: 'token-transfer',
        data: <TokenTransferEvent>{ ...commonData, from: output.from, to: output.to },
      };
    }
  }

  private async transformTransferBatchEvent(
    subName: string,
    event: TransferBatchEvent,
  ): Promise<WebSocketMessage[]> {
    const messages: WebSocketMessage[] = [];
    for (let i = 0; i < event.data.ids.length; i++) {
      const message = await this.transformTransferSingleEvent(
        subName,
        {
          ...event,
          data: {
            from: event.data.from,
            to: event.data.to,
            operator: event.data.operator,
            id: event.data.ids[i],
            value: event.data.values[i],
          },
        },
        i,
      );
      if (message !== undefined) {
        messages.push(message);
      }
    }
    return messages;
  }

  private transformApprovalForAllEvent(
    subName: string,
    event: ApprovalForAllEvent,
  ): WebSocketMessage | undefined {
    const { data: output } = event;
    const unpackedSub = unpackSubscriptionName(subName);
    const decodedData = decodeHex(event.inputArgs?.data ?? '');

    if (unpackedSub.poolLocator === undefined) {
      // should not happen
      return undefined;
    }
    const poolLocator = unpackPoolLocator(unpackedSub.poolLocator);

    // One event may apply across multiple pools
    // Include the poolId to generate a unique approvalId per pool
    const eventId = this.formatBlockchainEventId(event);
    const approvalId = eventId + '/' + poolLocator.poolId;

    return {
      event: 'token-approval',
      data: <TokenApprovalEvent>{
        id: approvalId,
        poolData: unpackedSub.poolData,
        subject: `${output.account}:${output.operator}`,
        poolLocator: unpackedSub.poolLocator,
        operator: output.operator,
        approved: output.approved,
        signer: output.account,
        data: decodedData,
        blockchain: {
          id: eventId,
          name: this.stripParamsFromSignature(this.trimEventSignature(event.signature)),
          location: 'address=' + event.address,
          signature: this.trimEventSignature(event.signature),
          timestamp: event.timestamp,
          output,
          info: {
            blockNumber: event.blockNumber,
            transactionIndex: event.transactionIndex,
            transactionHash: event.transactionHash,
            logIndex: event.logIndex,
            address: event.address,
            signature: this.trimEventSignature(event.signature),
          },
        },
      },
    };
  }

  private async getTokenUri(id: string): Promise<string> {
    try {
      const response = await this.service.query(
        ERC1155MixedFungibleAbi.find(m => m.name === 'uri'),
        [id],
      );
      const output = response.output as string;
      if (output.includes('{id}') === true) {
        return output.replace('{id}', encodeHexIDForURI(id));
      }
      return output;
    } catch (err) {
      return '';
    }
  }
}
