/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { User } from '../auth/user';

import { MutationQueue } from './mutation_queue';
import { PersistencePromise } from './persistence_promise';
import { QueryCache } from './query_cache';
import { RemoteDocumentCache } from './remote_document_cache';
import { ClientId } from './shared_client_state';
import { ListenSequenceNumber } from '../core/types';

/**
 * Opaque interface representing a persistence transaction.
 *
 * When you call Persistence.runTransaction(), it will create a transaction and
 * pass it to your callback. You then pass it to any method that operates
 * on persistence.
 */
export abstract class PersistenceTransaction {
  readonly currentSequenceNumber: ListenSequenceNumber;
}

/**
 * Callback type for primary state notifications. This callback can be
 * registered with the persistence layer to get notified when we transition from
 * primary to secondary state and vice versa.
 *
 * Note: Instances can only toggle between Primary and Secondary state if
 * IndexedDB persistence is enabled and multiple clients are active. If this
 * listener is registered with MemoryPersistence, the callback will be called
 * exactly once marking the current instance as Primary.
 */
export type PrimaryStateListener = (isPrimary: boolean) => Promise<void>;

/**
 * Persistence is the lowest-level shared interface to persistent storage in
 * Firestore.
 *
 * Persistence is used to create MutationQueue and RemoteDocumentCache
 * instances backed by persistence (which might be in-memory or LevelDB).
 *
 * Persistence also exposes an API to create and run PersistenceTransactions
 * against persistence. All read / write operations must be wrapped in a
 * transaction. Implementations of PersistenceTransaction / Persistence only
 * need to guarantee that writes made against the transaction are not made to
 * durable storage until the transaction resolves its PersistencePromise.
 * Since memory-only storage components do not alter durable storage, they are
 * free to ignore the transaction.
 *
 * This contract is enough to allow the LocalStore be be written
 * independently of whether or not the stored state actually is durably
 * persisted. If persistent storage is enabled, writes are grouped together to
 * avoid inconsistent state that could cause crashes.
 *
 * Concretely, when persistent storage is enabled, the persistent versions of
 * MutationQueue, RemoteDocumentCache, and others (the mutators) will
 * defer their writes into a transaction. Once the local store has completed
 * one logical operation, it commits the transaction.
 *
 * When persistent storage is disabled, the non-persistent versions of the
 * mutators ignore the transaction. This short-cut is allowed because
 * memory-only storage leaves no state so it cannot be inconsistent.
 *
 * This simplifies the implementations of the mutators and allows memory-only
 * implementations to supplement the persistent ones without requiring any
 * special dual-store implementation of Persistence. The cost is that the
 * LocalStore needs to be slightly careful about the order of its reads and
 * writes in order to avoid relying on being able to read back uncommitted
 * writes.
 */
export interface Persistence {
  /**
   * Whether or not this persistence instance has been started.
   */
  readonly started: boolean;

  /**
   * Releases any resources held during eager shutdown.
   *
   * @param deleteData Whether to delete the persisted data. This causes
   * irrecoverable data loss and should only be used to delete test data.
   */
  shutdown(deleteData?: boolean): Promise<void>;

  /**
   * Registers a listener that gets called when the primary state of the
   * instance changes. Upon registering, this listener is invoked immediately
   * with the current primary state.
   *
   * PORTING NOTE: This is only used for Web multi-tab.
   */
  setPrimaryStateListener(
    primaryStateListener: PrimaryStateListener
  ): Promise<void>;

  /**
   * Adjusts the current network state in the client's metadata, potentially
   * affecting the primary lease.
   *
   * PORTING NOTE: This is only used for Web multi-tab.
   */
  setNetworkEnabled(networkEnabled: boolean): void;

  /**
   * Returns the IDs of the clients that are currently active. If multi-tab
   * is not supported, returns an array that only contains the local client's
   * ID.
   *
   * PORTING NOTE: This is only used for Web multi-tab.
   */
  getActiveClients(): Promise<ClientId[]>;

  /**
   * Returns a MutationQueue representing the persisted mutations for the
   * given user.
   *
   * Note: The implementation is free to return the same instance every time
   * this is called for a given user. In particular, the memory-backed
   * implementation does this to emulate the persisted implementation to the
   * extent possible (e.g. in the case of uid switching from
   * sally=>jack=>sally, sally's mutation queue will be preserved).
   */
  getMutationQueue(user: User): MutationQueue;

  /**
   * Returns a QueryCache representing the persisted cache of queries.
   *
   * Note: The implementation is free to return the same instance every time
   * this is called. In particular, the memory-backed implementation does this
   * to emulate the persisted implementation to the extent possible.
   */
  getQueryCache(): QueryCache;

  /**
   * Returns a RemoteDocumentCache representing the persisted cache of remote
   * documents.
   *
   * Note: The implementation is free to return the same instance every time
   * this is called. In particular, the memory-backed implementation does this
   * to emulate the persisted implementation to the extent possible.
   */
  getRemoteDocumentCache(): RemoteDocumentCache;

  /**
   * Performs an operation inside a persistence transaction. Any reads or writes
   * against persistence must be performed within a transaction. Writes will be
   * committed atomically once the transaction completes.
   *
   * Persistence operations are asynchronous and therefore the provided
   * transactionOperation must return a PersistencePromise. When it is resolved,
   * the transaction will be committed and the Promise returned by this method
   * will resolve.
   *
   * @param action A description of the action performed by this transaction,
   * used for logging.
   * @param mode The underlying mode of the IndexedDb transaction. Can be
   * 'readonly`, 'readwrite' or 'readwrite-primary'. Transactions marked
   * 'readwrite-primary' can only be executed by the primary client. In this
   * mode, the transactionOperation will not be run if the primary lease cannot
   * be acquired and the returned promise will be rejected with a
   * FAILED_PRECONDITION error.
   * @param transactionOperation The operation to run inside a transaction.
   * @return A promise that is resolved once the transaction completes.
   */
  runTransaction<T>(
    action: string,
    mode: 'readonly' | 'readwrite' | 'readwrite-primary',
    transactionOperation: (
      transaction: PersistenceTransaction
    ) => PersistencePromise<T>
  ): Promise<T>;
}
