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

import { ShutdownSignal, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import { version as API_VERSION } from '../package.json';
import { AppModule } from './app.module';
import { RequestLoggingInterceptor } from './request-logging.interceptor';
import { TokensService } from './tokens/tokens.service';
import { EventStreamReply } from './event-stream/event-stream.interfaces';
import {
  TokenApprovalEvent,
  TokenBurnEvent,
  TokenMintEvent,
  TokenPoolEvent,
  TokenTransferEvent,
} from './tokens/tokens.interfaces';
import { EventStreamService } from './event-stream/event-stream.service';

const API_DESCRIPTION = `
<p>All POST APIs are asynchronous. Listen for websocket notifications on <code>/api/ws</code>.
`;

export function getApiConfig() {
  return new DocumentBuilder()
    .setTitle('FireFly Tokens - ERC1155')
    .setDescription(API_DESCRIPTION)
    .setVersion(API_VERSION)
    .build();
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGQUIT, ShutdownSignal.SIGINT]);
  app.useGlobalInterceptors(new RequestLoggingInterceptor());

  const apiConfig = getApiConfig();
  const api = SwaggerModule.createDocument(app, apiConfig, {
    extraModels: [
      EventStreamReply,
      TokenPoolEvent,
      TokenMintEvent,
      TokenBurnEvent,
      TokenTransferEvent,
      TokenApprovalEvent,
    ],
  });
  const config = app.get(ConfigService);

  SwaggerModule.setup('api', app, api);

  const ethConnectUrl = config.get<string>('ETHCONNECT_URL', '');
  const instancePath = config.get<string>('ETHCONNECT_INSTANCE', '');
  const topic = config.get<string>('ETHCONNECT_TOPIC', 'token');
  const shortPrefix = config.get<string>('ETHCONNECT_PREFIX', 'fly');
  const autoInit = config.get<string>('AUTO_INIT', 'true');
  const username = config.get<string>('ETHCONNECT_USERNAME', '');
  const password = config.get<string>('ETHCONNECT_PASSWORD', '');
  const contractAddress = config.get<string>('CONTRACT_ADDRESS', '');

  app.get(EventStreamService).configure(ethConnectUrl, username, password);
  app
    .get(TokensService)
    .configure(
      ethConnectUrl,
      instancePath,
      topic,
      shortPrefix,
      username,
      password,
      contractAddress,
    );

  if (autoInit.toLowerCase() !== 'false') {
    await app.get(TokensService).init();
  }

  const port = config.get<number>('PORT', 3000);
  console.log(`Listening on port ${port}`);
  await app.listen(port);
}

bootstrap().catch(err => {
  console.error(`Fatal error: ${err}`);
});
