// Copyright © 2022 Kaleido, Inc.
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

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { lastValueFrom } from 'rxjs';
import * as WebSocket from 'ws';
import { IAbiMethod } from '../tokens/tokens.interfaces';
import { basicAuth } from '../utils';
import {
  Event,
  EventBatch,
  EventStream,
  EventStreamReply,
  EventStreamSubscription,
} from './event-stream.interfaces';

const RECONNECT_TIME = 5000;
const PING_INTERVAL = 10000;
const PING_TIMEOUT = 60000;

export class EventStreamSocket {
  private readonly logger = new Logger(EventStreamSocket.name);

  private ws: WebSocket;
  private pingTimeout: NodeJS.Timeout;
  private disconnectDetected = false;
  private closeRequested = false;

  constructor(
    private url: string,
    private topic: string,
    private username: string,
    private password: string,
    private handleEvents: (events: EventBatch) => void,
    private handleReceipt: (receipt: EventStreamReply) => void,
  ) {
    this.init();
  }

  private init() {
    this.disconnectDetected = false;
    this.closeRequested = false;

    const auth =
      this.username && this.password ? { auth: `${this.username}:${this.password}` } : undefined;
    this.ws = new WebSocket(this.url, auth);
    this.ws
      .on('open', () => {
        if (this.disconnectDetected) {
          this.disconnectDetected = false;
          this.logger.log('Event stream websocket restored');
        } else {
          this.logger.log('Event stream websocket connected');
        }
        this.produce({ type: 'listen', topic: this.topic });
        this.produce({ type: 'listenreplies' });
        this.ping();
      })
      .on('close', () => {
        if (this.closeRequested) {
          this.logger.log('Event stream websocket closed');
        } else {
          this.disconnectDetected = true;
          this.logger.error(
            `Event stream websocket disconnected, attempting to reconnect in ${RECONNECT_TIME}ms`,
          );
          setTimeout(() => this.init(), RECONNECT_TIME);
        }
      })
      .on('message', (message: string) => {
        this.handleMessage(JSON.parse(message));
      })
      .on('pong', () => {
        clearTimeout(this.pingTimeout);
        setTimeout(() => this.ping(), PING_INTERVAL);
      })
      .on('error', err => {
        this.logger.error(`Event stream websocket error: ${err}`);
      });
  }

  private ping() {
    if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
      this.pingTimeout = setTimeout(() => {
        this.logger.error('Event stream ping timeout');
        this.ws.terminate();
      }, PING_TIMEOUT);
    }
  }

  private produce(message: any) {
    this.ws.send(JSON.stringify(message));
  }

  ack(batchNumber: number | undefined) {
    this.produce({ type: 'ack', topic: this.topic, batchNumber });
  }

  close() {
    this.closeRequested = true;
    this.ws.terminate();
  }

  private handleMessage(message: EventStreamReply | Event[] | EventBatch) {
    if (Array.isArray(message)) {
      for (const event of message) {
        this.logger.log(`Ethconnect '${event.signature}' message: ${JSON.stringify(event.data)}`);
      }
      this.handleEvents({ events: message });
    } else if ('batchNumber' in message && Array.isArray(message.events)) {
      for (const event of message.events) {
        this.logger.log(
          `Ethconnect '${event.signature}' message (batch=${message.batchNumber}): ${JSON.stringify(
            event.data,
          )}`,
        );
      }
      this.handleEvents(message);
    } else {
      const reply = message as EventStreamReply;
      const replyType = reply.headers.type;
      const errorMessage = reply.errorMessage ?? '';
      this.logger.log(
        `Ethconnect '${replyType}' reply request=${reply.headers.requestId} tx=${reply.transactionHash} ${errorMessage}`,
      );
      this.handleReceipt(reply);
    }
  }
}

@Injectable()
export class EventStreamService {
  private readonly logger = new Logger(EventStreamService.name);

  private baseUrl: string;
  private username: string;
  private password: string;

  constructor(private http: HttpService) {}

  configure(baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl;
    this.username = username;
    this.password = password;
  }

  async getStreams(): Promise<EventStream[]> {
    const response = await lastValueFrom(
      this.http.get<EventStream[]>(new URL('/eventstreams', this.baseUrl).href, {
        ...basicAuth(this.username, this.password),
      }),
    );
    return response.data;
  }

  async createOrUpdateStream(name: string, topic: string): Promise<EventStream> {
    const streamDetails = {
      name,
      errorHandling: 'block',
      batchSize: 50,
      batchTimeoutMS: 500,
      type: 'websocket',
      websocket: { topic },
      blockedReryDelaySec: 30, // intentional due to spelling error in ethconnect
      inputs: true,
      timestamps: true,
    };

    const existingStreams = await this.getStreams();
    const stream = existingStreams.find(s => s.name === streamDetails.name);
    if (stream) {
      const patchedStreamRes = await lastValueFrom(
        this.http.patch<EventStream>(
          new URL(`/eventstreams/${stream.id}`, this.baseUrl).href,
          {
            ...streamDetails,
          },
          {
            ...basicAuth(this.username, this.password),
          },
        ),
      );
      this.logger.log(`Event stream for ${topic}: ${stream.id}`);
      return patchedStreamRes.data;
    }
    const newStreamRes = await lastValueFrom(
      this.http.post<EventStream>(
        new URL('/eventstreams', this.baseUrl).href,
        {
          ...streamDetails,
        },
        {
          ...basicAuth(this.username, this.password),
        },
      ),
    );
    this.logger.log(`Event stream for ${topic}: ${newStreamRes.data.id}`);
    return newStreamRes.data;
  }

  async deleteStream(id: string) {
    await lastValueFrom(
      this.http.delete(new URL(`/eventstreams/${id}`, this.baseUrl).href, {
        ...basicAuth(this.username, this.password),
      }),
    );
  }

  async getSubscriptions(): Promise<EventStreamSubscription[]> {
    const response = await lastValueFrom(
      this.http.get<EventStreamSubscription[]>(new URL('/subscriptions', this.baseUrl).href, {
        ...basicAuth(this.username, this.password),
      }),
    );
    return response.data;
  }

  async getSubscription(subId: string): Promise<EventStreamSubscription | undefined> {
    const response = await lastValueFrom(
      this.http.get<EventStreamSubscription>(
        new URL(`/subscriptions/${subId}`, this.baseUrl).href,
        {
          validateStatus: status => status < 300 || status === 404,
          ...basicAuth(this.username, this.password),
        },
      ),
    );
    if (response.status === 404) {
      return undefined;
    }
    return response.data;
  }

  async createSubscription(
    instancePath: string,
    eventABI: IAbiMethod,
    streamId: string,
    event: string,
    name: string,
    address: string,
    methods: IAbiMethod[],
    fromBlock = '0', // subscribe from the start of the chain by default
  ): Promise<EventStreamSubscription> {
    const response = await lastValueFrom(
      this.http.post<EventStreamSubscription>(
        new URL(`/subscriptions`, instancePath).href,
        {
          name,
          stream: streamId,
          fromBlock,
          event: eventABI,
          address,
          methods,
        },
        {
          ...basicAuth(this.username, this.password),
        },
      ),
    );
    this.logger.log(`Created subscription ${event}: ${response.data.id}`);
    return response.data;
  }

  async getOrCreateSubscription(
    instancePath: string,
    eventABI: IAbiMethod,
    streamId: string,
    event: string,
    name: string,
    contractAddress: string,
    possibleABIs: IAbiMethod[],
    fromBlock = '0', // subscribe from the start of the chain by default
  ): Promise<EventStreamSubscription> {
    const existingSubscriptions = await this.getSubscriptions();
    const sub = existingSubscriptions.find(s => s.name === name && s.stream === streamId);
    if (sub) {
      this.logger.log(`Existing subscription for ${event}: ${sub.id}`);
      return sub;
    }
    return this.createSubscription(
      instancePath,
      eventABI,
      streamId,
      event,
      name,
      contractAddress,
      possibleABIs,
      fromBlock,
    );
  }

  connect(
    url: string,
    topic: string,
    handleEvents: (events: EventBatch) => void,
    handleReceipt: (receipt: EventStreamReply) => void,
  ) {
    return new EventStreamSocket(
      url,
      topic,
      this.username,
      this.password,
      handleEvents,
      handleReceipt,
    );
  }
}
