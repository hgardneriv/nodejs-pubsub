/*!
 * Copyright 2019 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as pfy from '@google-cloud/promisify';
import * as assert from 'assert';
import {describe, it, before, beforeEach, afterEach} from 'mocha';
import {EventEmitter} from 'events';
import * as proxyquire from 'proxyquire';
import * as sinon from 'sinon';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/tracing';
import * as opentelemetry from '@opentelemetry/api';

import {Topic} from '../../src';
import * as p from '../../src/publisher';
import * as q from '../../src/publisher/message-queues';
import {PublishError} from '../../src/publisher/publish-error';

import {defaultOptions} from '../../src/default-options';

let promisified = false;
const fakePromisify = Object.assign({}, pfy, {
  promisifyAll: (ctor: Function, options: pfy.PromisifyAllOptions) => {
    if (ctor.name !== 'Publisher') {
      return;
    }
    promisified = true;
    assert.ok(options.singular);
    assert.deepStrictEqual(options.exclude, [
      'publish',
      'setOptions',
      'constructSpan',
    ]);
  },
});

class FakeQueue extends EventEmitter {
  publisher: p.Publisher;
  constructor(publisher: p.Publisher) {
    super();
    this.publisher = publisher;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  add(message: p.PubsubMessage, callback: p.PublishCallback): void {}
  publish(callback: (err: Error | null) => void) {
    this._publish([], [], callback);
  }
  _publish(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    messages: p.PubsubMessage[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    callbacks: p.PublishCallback[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    callback?: q.PublishDone
  ) {}
}

class FakeOrderedQueue extends FakeQueue {
  orderingKey: string;
  error?: Error;
  constructor(publisher: p.Publisher, key: string) {
    super(publisher);
    this.orderingKey = key;
  }
  resumePublishing(): void {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  publish(callback: (err: Error | null) => void) {
    this._publish([], [], callback);
  }
  _publish(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    messages: p.PubsubMessage[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    callbacks: p.PublishCallback[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    callback?: q.PublishDone
  ) {}
}

describe('Publisher', () => {
  const sandbox = sinon.createSandbox();
  const topic = {} as Topic;

  // tslint:disable-next-line variable-name
  let Publisher: typeof p.Publisher;
  let publisher: p.Publisher;

  before(() => {
    const mocked = proxyquire('../../src/publisher/index.js', {
      '@google-cloud/promisify': fakePromisify,
      './message-queues': {
        Queue: FakeQueue,
        OrderedQueue: FakeOrderedQueue,
      },
    });

    Publisher = mocked.Publisher;
  });

  beforeEach(() => {
    publisher = new Publisher(topic);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('initialization', () => {
    it('should promisify all the things', () => {
      assert(promisified);
    });

    it('should capture user options', () => {
      const stub = sandbox.stub(Publisher.prototype, 'setOptions');

      const options = {};
      publisher = new Publisher(topic, options);

      assert.ok(stub.calledWith(options));
    });

    it('should localize topic instance', () => {
      assert.strictEqual(publisher.topic, topic);
    });

    it('should create a message queue', () => {
      assert(publisher.queue instanceof FakeQueue);
      assert.strictEqual(publisher.queue.publisher, publisher);
    });

    it('should create a map for ordered queues', () => {
      assert(publisher.orderedQueues instanceof Map);
    });
  });

  describe('publish', () => {
    const buffer = Buffer.from('Hello, world!');
    const spy = sandbox.spy();

    it('should call through to publishMessage', () => {
      const stub = sandbox.stub(publisher, 'publishMessage');

      publisher.publish(buffer, spy);

      const [{data}, callback] = stub.lastCall.args;
      assert.strictEqual(data, buffer);
      assert.strictEqual(callback, spy);
    });

    it('should optionally accept attributes', () => {
      const stub = sandbox.stub(publisher, 'publishMessage');
      const attrs = {};

      publisher.publish(buffer, attrs, spy);

      const [{attributes}, callback] = stub.lastCall.args;
      assert.strictEqual(attributes, attrs);
      assert.strictEqual(callback, spy);
    });
  });

  describe('OpenTelemetry tracing', () => {
    let tracingPublisher: p.Publisher = {} as p.Publisher;
    const enableTracing: p.PublishOptions = {
      enableOpenTelemetryTracing: true,
    };
    const disableTracing: p.PublishOptions = {
      enableOpenTelemetryTracing: false,
    };
    const buffer = Buffer.from('Hello, world!');

    beforeEach(() => {
      // Declare tracingPublisher as type any and pre-define _tracing
      // to gain access to the private field after publisher init
      tracingPublisher['tracing'] = undefined;
    });
    it('should not instantiate a tracer when tracing is disabled', () => {
      tracingPublisher = new Publisher(topic);
      assert.strictEqual(tracingPublisher['tracing'], undefined);
    });

    it('should instantiate a tracer when tracing is enabled through constructor', () => {
      tracingPublisher = new Publisher(topic, enableTracing);
      assert.ok(tracingPublisher['tracing']);
    });

    it('should instantiate a tracer when tracing is enabled through setOptions', () => {
      tracingPublisher = new Publisher(topic);
      tracingPublisher.setOptions(enableTracing);
      assert.ok(tracingPublisher['tracing']);
    });

    it('should disable tracing when tracing is disabled through setOptions', () => {
      tracingPublisher = new Publisher(topic, enableTracing);
      tracingPublisher.setOptions(disableTracing);
      assert.strictEqual(tracingPublisher['tracing'], undefined);
    });

    it('export created spans', () => {
      tracingPublisher = new Publisher(topic, enableTracing);

      // Setup trace exporting
      const provider: BasicTracerProvider = new BasicTracerProvider();
      const exporter: InMemorySpanExporter = new InMemorySpanExporter();
      provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
      provider.register();
      opentelemetry.trace.setGlobalTracerProvider(provider);

      tracingPublisher.publish(buffer);
      assert.ok(exporter.getFinishedSpans());
    });
  });

  describe('publishMessage', () => {
    const data = Buffer.from('hello, world!');
    const spy = sandbox.spy();

    it('should throw an error if data is not a Buffer', () => {
      const badData = {} as Buffer;
      assert.throws(
        () => publisher.publishMessage({data: badData}, spy),
        /Data must be in the form of a Buffer\./
      );
    });

    it('should throw an error if attributes are wrong format', () => {
      const attributes = {foo: {bar: 'baz'}} as {};

      assert.throws(
        () => publisher.publishMessage({data, attributes}, spy),
        /All attributes must be in the form of a string.\n\nInvalid value of type "object" provided for "foo"\./
      );
    });

    it('should add non-ordered messages to the message queue', () => {
      const stub = sandbox.stub(publisher.queue, 'add');
      const fakeMessage = {data};

      publisher.publishMessage(fakeMessage, spy);

      const [message, callback] = stub.lastCall.args;
      assert.strictEqual(message, fakeMessage);
      assert.strictEqual(callback, spy);
    });

    describe('ordered messages', () => {
      const orderingKey = 'foo';
      const fakeMessage = {data, orderingKey};

      let queue: FakeOrderedQueue;

      beforeEach(() => {
        queue = new FakeOrderedQueue(publisher, orderingKey);
        publisher.orderedQueues.set(
          orderingKey,
          (queue as unknown) as q.OrderedQueue
        );
      });

      it('should create a new queue for a message if need be', () => {
        publisher.orderedQueues.clear();
        publisher.publishMessage(fakeMessage, spy);

        queue = (publisher.orderedQueues.get(
          orderingKey
        ) as unknown) as FakeOrderedQueue;

        assert(queue instanceof FakeOrderedQueue);
        assert.strictEqual(queue.publisher, publisher);
        assert.strictEqual(queue.orderingKey, orderingKey);
      });

      it('should add the ordered message to the correct queue', () => {
        const stub = sandbox.stub(queue, 'add');

        publisher.publishMessage(fakeMessage, spy);

        const [message, callback] = stub.lastCall.args;
        assert.strictEqual(message, fakeMessage);
        assert.strictEqual(callback, spy);
      });

      it('should return an error if the queue encountered an error', done => {
        const error = new Error('err') as PublishError;
        sandbox
          .stub(queue, 'add')
          .callsFake((message, callback) => callback(error));

        publisher.publishMessage(fakeMessage, err => {
          assert.strictEqual(err, error);
          done();
        });
      });

      it('should delete the queue once it is empty', () => {
        publisher.orderedQueues.clear();
        publisher.publishMessage(fakeMessage, spy);

        queue = (publisher.orderedQueues.get(
          orderingKey
        ) as unknown) as FakeOrderedQueue;
        queue.emit('drain');

        assert.strictEqual(publisher.orderedQueues.size, 0);
      });

      it('should drain any ordered queues on flush', done => {
        // We have to stub out the regular queue as well, so that the flush() operation finishes.
        sandbox
          .stub(FakeQueue.prototype, '_publish')
          .callsFake((messages, callbacks, callback) => {
            if (typeof callback === 'function') callback(null);
          });

        sandbox
          .stub(FakeOrderedQueue.prototype, '_publish')
          .callsFake((messages, callbacks, callback) => {
            const queue = (publisher.orderedQueues.get(
              orderingKey
            ) as unknown) as FakeOrderedQueue;
            queue.emit('drain');
            if (typeof callback === 'function') callback(null);
          });

        publisher.orderedQueues.clear();
        publisher.publishMessage(fakeMessage, spy);

        publisher.flush(err => {
          assert.strictEqual(err, null);
          assert.strictEqual(publisher.orderedQueues.size, 0);
          done();
        });
      });

      it('should issue a warning if OpenTelemetry span context key is set', () => {
        const warnSpy = sinon.spy(console, 'warn');
        const attributes = {
          googclient_OpenTelemetrySpanContext: 'foobar',
        };
        const fakeMessageWithOTKey = {data, attributes};
        const publisherTracing = new Publisher(topic, {
          enableOpenTelemetryTracing: true,
        });
        publisherTracing.publishMessage(fakeMessageWithOTKey, warnSpy);
        assert.ok(warnSpy.called);
        warnSpy.restore();
      });
    });
  });

  describe('resumePublishing', () => {
    it('should resume publishing for the provided ordering key', () => {
      const orderingKey = 'foo';
      const queue = new FakeOrderedQueue(publisher, orderingKey);
      const stub = sandbox.stub(queue, 'resumePublishing');

      publisher.orderedQueues.set(
        orderingKey,
        (queue as unknown) as q.OrderedQueue
      );
      publisher.resumePublishing(orderingKey);

      assert.strictEqual(stub.callCount, 1);
    });
  });

  describe('setOptions', () => {
    it('should apply default values', () => {
      publisher.setOptions({});

      assert.deepStrictEqual(publisher.settings, {
        batching: {
          maxBytes: defaultOptions.publish.maxOutstandingBytes,
          maxMessages: defaultOptions.publish.maxOutstandingMessages,
          maxMilliseconds: defaultOptions.publish.maxDelayMillis,
        },
        messageOrdering: false,
        gaxOpts: {
          isBundling: false,
        },
        enableOpenTelemetryTracing: false,
      });
    });

    it('should capture user provided values', () => {
      const options = {
        batching: {
          maxBytes: 10,
          maxMessages: 10,
          maxMilliseconds: 1,
        },
        messageOrdering: true,
        gaxOpts: {
          isBundling: true,
        },
        enableOpenTelemetryTracing: true,
      };

      publisher.setOptions(options);

      assert.deepStrictEqual(publisher.settings, options);
    });

    it('should cap maxBytes at 9MB', () => {
      publisher.setOptions({
        batching: {
          maxBytes: Math.pow(1024, 2) * 10,
        },
      });

      const expected = Math.pow(1024, 2) * 9;
      assert.strictEqual(publisher.settings.batching!.maxBytes, expected);
    });

    it('should cap maxMessages at 1000', () => {
      publisher.setOptions({
        batching: {
          maxMessages: 1001,
        },
      });
      assert.strictEqual(publisher.settings.batching!.maxMessages, 1000);
    });
  });

  describe('flush', () => {
    // The ordered queue drain test is above with the ordered queue tests.
    it('should drain the main publish queue', done => {
      sandbox
        .stub(publisher.queue, '_publish')
        .callsFake((messages, callbacks, callback) => {
          if (typeof callback === 'function') callback(null);
        });

      publisher.flush(err => {
        assert.strictEqual(err, null);
        assert.strictEqual(
          !publisher.queue.batch || publisher.queue.batch.messages.length === 0,
          true
        );
        done();
      });
    });
  });
});
