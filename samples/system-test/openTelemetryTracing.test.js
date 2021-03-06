// Copyright 2021 Google LLC
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

'use strict';

const {PubSub} = require('@google-cloud/pubsub');
const {assert} = require('chai');
const {describe, it, before, after} = require('mocha');
const cp = require('child_process');
const uuid = require('uuid');

const execSync = cmd => cp.execSync(cmd, {encoding: 'utf-8'});

describe('openTelemetry', () => {
  const projectId = process.env.GCLOUD_PROJECT;
  const pubsub = new PubSub({projectId});
  const topicName = `nodejs-docs-samples-test-${uuid.v4()}`;
  const subName = `nodejs-docs-samples-test-${uuid.v4()}`;

  before(async () => {
    await pubsub.createTopic(topicName);
    await pubsub.topic(topicName).createSubscription(subName);
  });

  after(async () => {
    await pubsub.subscription(subName).delete();
    await pubsub.topic(topicName).delete();
  });

  it('should run the openTelemetryTracing sample', async () => {
    const stdout = execSync(
      `node openTelemetryTracing ${topicName} ${subName}`
    );
    assert.match(stdout, /traceId/);
    assert.match(stdout, /Message .* published./);
    assert.match(stdout, /Message .* received/);
    assert.notMatch(stdout, /Received error/);
  });
});
