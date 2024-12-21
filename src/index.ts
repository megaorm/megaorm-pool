import { EventEmitter } from 'events';

import { MaxConnectionError } from '@megaorm/errors';
import { MaxQueueTimeError } from '@megaorm/errors';
import { MaxQueueSizeError } from '@megaorm/errors';
import { ShutdownError } from '@megaorm/errors';

import { MegaConnection } from '@megaorm/driver';
import { MegaQueryResult } from '@megaorm/driver';
import { MegaDriver } from '@megaorm/driver';

import { isBool, isInt, isObj, isUndefined } from '@megaorm/test';
import { isPoolCon, isDriver } from '@megaorm/utils';

import { Echo } from '@megaorm/echo';
import { UTC } from '@megaorm/utc';

/**
 * Represents a connection that could not be closed by `MegaPool` instance.
 * @note MegaPool closes connections automatically:
 * - In case the connection closing resolves: no action needed.
 * - In case connection closing rejects: a `CLOSE_FAIL` event is emitted for you with the pending connection.
 * @note You should handle the `CLOSE_FAIL` event and store pending connections for later closing attempts.
 * @note Consider having a dashboard in your application to display and close pending connections.
 */
export interface MegaPendingConnection {
  /**
   * The unique identifier for the connection.
   */
  id: Symbol;

  /**
   * Attempts to close the connection.
   * @returns A promise that resolves once the connection is closed.
   * @throws Throws a `CloseConnectionError` if the connection closure fails.
   * @example
   *
   * // First, listen for the CLOSE_FAIL event and store pending connections
   * pool.on(CLOSE_FAIL, (connection, error) => {
   *   // You have access to the error
   *   console.log(error);
   *
   *   // Attempt to close the pending connection
   *   connection.close().catch((error) => {
   *     // Store the connection for later closing attempts
   *     connections.push(connection);
   *   });
   * });
   *
   * // Now when you are free, try closing all pending connections
   * const promises = connections.map((connection) => connection.close());
   * Promise.allSettled(promises)
   *   .then(() => console.log('Yes'))
   *   .catch(() => console.log('No'));
   *
   * // If you are using a MegaCluster instance, I do store pending connections for you:
   * cluster.has.pending(); // True or false
   * cluster.closePendingConnections(); // Executes the close method on every pending connection
   *
   */
  close(): Promise<void>;
}

/**
 * Represents a connection managed by `MegaPool` instance.
 * This interface provides methods for executing queries, managing transactions,
 * and releasing the connection back to the pool.
 *
 * @note Make sure to release the connection when done to avoid errors.
 */
export interface MegaPoolConnection {
  /**
   * The unique identifier for the connection.
   */
  id: Symbol;

  /**
   * The driver for the connection (e.g., `MySQL`, `SQLite`).
   */
  driver: MegaDriver;

  /**
   * Releases the connection back to the pool.
   * @example
   * // Acquire a connection
   * const connection = await pool.request();
   *
   * // Execute queries
   * const result = await connection.query(sql);
   *
   * // Release the connection back
   * connection.release();
   *
   * // Now you can no longer use the connection
   * connection.release(); // Throws an error
   * connection.query(sql); // Rejects with an error
   * connection.beginTransaction(); // Rejects with an error
   * connection.commit(); // Rejects with an error
   * connection.rollback(); // Rejects with an error
   *
   * @note Once you release a connection back to the pool, you can no longer use it.
   * @note Once you release a connection, it becomes idle.
   * @note Once you release a connection, it becomes the resolve value of another request (if shouldQueue is true).
   * @note Make sure to release the connection; otherwise, the shutdown of the pool will fail.
   */
  release(): void;

  /**
   * Executes a SQL query on the database.
   *
   * @param sql - The SQL query to execute.
   * @param values - Optional array of values to substitute in the SQL query.
   *
   * @returns A promise that resolves with the result of the query.
   *
   * @example
   * // Request connection
   * const connection = await pool.request();
   *
   * // SELECT query
   * const users = await connection.query('SELECT * FROM users WHERE status = ?', ['active']);
   * console.log(users); // Array of objects
   *
   * // INSERT query
   * const result = await connection.query('INSERT INTO users (name) VALUES (?)', ['John Doe']);
   * console.log(result); // undefined
   *
   * @note This method resolves with `Rows` in SELECT queries, otherwise `undefined` for other query types.
   */
  query(sql: string, values?: Array<string | number>): Promise<MegaQueryResult>;

  /**
   * Starts a new transaction on the database connection.
   * @returns A promise that resolves when the transaction is started.
   *
   * @note
   * Transactions are critical when performing operations that depend on each other, ensuring that either all operations are executed successfully or none at all.
   * For example, when inserting a new user and their corresponding profile, you want to make sure both entries are created together.
   * If the insert for the user is successful but the insert for the profile fails, a transaction allows you to roll back the entire operation,
   * ensuring that neither entry exists in the database, maintaining data integrity
   *
   * @example
   * // Request connection
   * const connection = await pool.request();
   *
   * // Begin a transaction
   * await connection.beginTransaction();
   * console.log('Transaction started');
   *
   * try {
   *   // Insert a new user
   *   await connection.query('INSERT INTO users (name) VALUES (?)', ['Jane Doe']);
   *
   *   // Execute a SELECT statement to get the newly inserted user's ID
   *   const userResult = await connection.query('SELECT id FROM users WHERE name = ?', ['Jane Doe']);
   *   const userId = userResult[0].id; // Get the ID of the newly inserted user
   *
   *   // Insert a profile for the new user
   *   await connection.query('INSERT INTO profiles (userId, bio) VALUES (?, ?)', [userId, 'This is Jane Doe\'s bio']);
   *
   *   // Commit the transaction if both inserts succeed
   *   await connection.commit(); // commit transaction
   *   console.log('Transaction committed');
   * } catch (err) {
   *   // If any operation fails, rollback the transaction
   *   await connection.rollback(); // rollback transaction
   *   console.log('Transaction rolled back due to an error:', err);
   * }
   */
  beginTransaction(): Promise<void>;

  /**
   * Commits the current transaction on the database connection.
   *
   * @returns A promise that resolves when the transaction is committed.
   *
   * @example
   * // Request connection
   * const connection = await pool.request;
   *
   * // Start and commit a transaction
   * await connection.beginTransaction();
   * await connection.query('INSERT INTO users (name) VALUES (?)', ['Jane Doe']);
   * await connection.commit();
   * console.log('Transaction committed');
   */
  commit(): Promise<void>;

  /**
   * Rolls back the current transaction on the database connection.
   *
   * @returns A promise that resolves when the transaction is rolled back.
   *
   * @example
   * // Request connection
   * const connection = await pool.request;
   *
   * await connection.beginTransaction();
   * try {
   *   await connection.query('UPDATE users SET name = ? WHERE id = ?', ['Invalid', 999]);
   *   await connection.commit();
   * } catch (err) {
   *   await connection.rollback();
   *   console.log('Transaction rolled back');
   * }
   */
  rollback(): Promise<void>;
}

/**
 * Options for configuring the connection pool.
 *
 * @property `maxConnection` - Max number of connections to create in the pool.
 * @property `maxIdleTime` - Lifetime (ms) of idle connections before closure.
 * @property `shouldQueue` - Should requests be queued if no idle connections are available.
 * @property `maxQueueSize` - Max number of connection requests that can be queued.
 * @property `maxQueueTime` - Max time (ms) a request can remain queued before rejection.
 * @property `shouldRetry` - Whether to retry connection creation and closing on failure.
 * @property `maxRetry` - Max number of times to retry connection creation and closing failure.
 * @property `retryDelay` - Max time (ms) to wait between retry attempts.
 * @property `extraDelay` - Additional time (ms) added between retry attempts.
 */
export interface MegaPoolOptions {
  maxConnection?: number;
  maxIdleTime?: number;
  shouldQueue?: boolean;
  maxQueueSize?: number;
  maxQueueTime?: number;
  shouldRetry?: boolean;
  maxRetry?: number;
  retryDelay?: number;
  extraDelay?: number;
}

const createPendingConnection = (
  inner: MegaConnection
): MegaPendingConnection => {
  const pending = {
    id: Symbol('MegaPendingConnection'),

    // Method to close the connection
    close() {
      return new Promise<void>((resolve, reject) => {
        inner
          .close()
          .then(() => {
            function close() {
              return Promise.resolve();
            }

            pending.close = close; // Update close to always resolve
            resolve(); // Resolve the promise after a successful close
          })
          .catch(reject); // Reject if there's an error
      });
    },
  };

  return pending;
};

const createPoolConnection = (
  pool: MegaPool,
  inner: MegaConnection
): MegaPoolConnection => {
  // Directly returning an object
  return {
    // Property: Unique Symbol ID for the connection
    id: Symbol('MegaPoolConnection'),

    // Property: Reference to the driver
    driver: inner.driver,

    // Method: Releases the connection back to the pool
    release() {
      return pool.release(this); // 'this' refers to the returned object
    },

    // Method: Executes a query
    query(sql: string, values?: Array<string | number>) {
      return new Promise<MegaQueryResult>((resolve, reject) => {
        inner
          .query(sql, values)
          .then((data) => {
            pool.emit(QUERY_SUCCESS, data);
            return resolve(data);
          })
          .catch((error) => {
            pool.emit(QUERY_FAIL, error);
            return reject(error);
          });
      });
    },

    // Method: Starts a transaction
    beginTransaction() {
      return new Promise<void>((resolve, reject) => {
        inner
          .beginTransaction()
          .then(() => {
            pool.emit(TRANSACTION_SUCCESS);
            return resolve();
          })
          .catch((error: Error) => {
            pool.emit(TRANSACTION_FAIL, error);
            return reject(error);
          });
      });
    },

    // Method: Commits the current transaction
    commit() {
      return new Promise<void>((resolve, reject) => {
        inner
          .commit()
          .then(() => {
            pool.emit(COMMIT_SUCCESS);
            return resolve();
          })
          .catch((error: Error) => {
            pool.emit(COMMIT_FAIL, error);
            return reject(error);
          });
      });
    },

    // Method: Rolls back the current transaction
    rollback() {
      return new Promise<void>((resolve, reject) => {
        inner
          .rollback()
          .then(() => {
            pool.emit(ROLLBACK_SUCCESS);
            return resolve();
          })
          .catch((error) => {
            pool.emit(ROLLBACK_FAIL, error);
            return reject(error);
          });
      });
    },
  }; // End of returned object
};

type AcquiredConnection = {
  inner: MegaConnection;
  outter: MegaPoolConnection;
};

type IdleConnection = {
  id: NodeJS.Timeout;
  connection: MegaConnection;
};

type ConnectionRequest = {
  id: NodeJS.Timeout;
  resolve: (connection: MegaPoolConnection) => void;
};

/**
 * Represents the counts of connections in the pool.
 */
interface Counts {
  /**
   * Gets the count of acquired connections.
   * @returns The number of acquired connections.
   * @example
   *
   * // Get acquired connections count
   * pool.get.count.acquired();
   */
  acquired(): number;

  /**
   * Gets the count of idle connections.
   * @returns The number of idle connections.
   * @example
   *
   * // Get idle connections count
   * pool.get.count.idle();
   */
  idle(): number;

  /**
   * Gets the count of queued connection requests.
   * @returns The number of queued connection requests.
   * @example
   *
   * // Get connection requests count
   * pool.get.count.request(); // number of connection requests in the queue
   */
  request(): number;
}

/**
 * Represents the return type of `get` property in the pool.
 */
interface Getter {
  /**
   * Gets the connection counts (acquired, idle, and requested).
   * @example
   *
   * // Get acquired connections count
   * pool.get.count.acquired();
   *
   * // Get idle connections count
   * pool.get.count.idle();
   *
   * // Get connection requests count
   * pool.get.count.request(); // number of connection requests in the queue
   */
  count: Counts;

  /**
   * Gets the current options of the pool.
   * @returns An object containing the pool options.
   * @example
   *
   * // Get pool options
   * pool.get.options(); // an object of options
   *
   * // Updating options won't have any affects
   * const options = pool.get.options();
   * options.maxConnection = 12; // won't work
   *
   * // Get the options again
   * console.log(pool.get.options().maxConnection); // 10 default maxConections
   *
   * // Instead of updating options you should create a new pool instance
   * const pool = new MegaPool(driver, {maxConnection: 12}); // The right way
   *
   * // Updating options won't throw any errors
   * const options = pool1.get.options();
   * options.maxConnection = 2;
   * const pool2 = new MegaPool(driver, options); // maxConnection now is 2
   *
   * @note Options returned by `get.options()` are read-only values
   * @note Updating `options` won't affect the pool!
   */
  options(): MegaPoolOptions;

  /**
   * Gets the name of the pool driver.
   * @returns The name of the driver as a DriverName.
   * @example
   *
   * // Get the driver used by the pool to create connections
   * const driver = pool.get.driver(); // MegaDriver
   *
   */
  driver(): MegaDriver;

  /**
   * Determines the performance of the pool based on acquired connections.
   * @returns The performance rating of the pool: BAD_POOL, GOOD_POOL, or BAD_POOL.
   * @example
   *
   * // Get performance
   * const performance = pool.get.performance();
   *
   * // Check if performance is great
   * if(performance === GREAT_POOL) console.log('great');
   *
   * // Check if performance is good
   * if(performance === GOOD_POOL) console.log('good');
   *
   * // Check if performance is bad
   * if(performance === BAD_POOL) console.log('bad');
   */
  performance(): Symbol;
}

/**
 * Represents the return type of `has` property in the pool.
 */
interface Checker {
  /**
   * Checks if the pool has any acquired connections.
   * @returns True if there are acquired connections, otherwise false.
   * @example
   *
   * // Check if the pool has acquired connections
   * if(pool.has.acquired()) console.log('yes');
   */
  acquired(): boolean;

  /**
   * Checks if the pool has any idle connections.
   * @returns True if there are idle connections, otherwise false.
   * @example
   *
   * // Check if the pool has idle connections
   * if(pool.has.idle()) console.log('yes');
   */
  idle(): boolean;

  /**
   * Checks if there are any queued connection requests.
   * @returns True if there are queued requests, otherwise false.
   * @example
   *
   * // Check if the pool has connection requests
   * if(pool.has.request()) console.log('yes');
   */
  request(): boolean;
}

/**
 * Symbol representing a great connection pool.
 * @constant GREAT_POOL
 */
export const GREAT_POOL = Symbol('GREAT_POOL');

/**
 * Symbol representing a good connection pool.
 * @constant GOOD_POOL
 */
export const GOOD_POOL = Symbol('GOOD_POOL');

/**
 * Symbol representing a bad connection pool.
 * @constant BAD_POOL
 */
export const BAD_POOL = Symbol('BAD_POOL');

/**
 * @event QUERY_FAIL Emitted when a query execution fails.
 * @argument error QueryError instance
 */
export const QUERY_FAIL = Symbol('QUERY_FAIL');

/**
 * @event CREATE_FAIL Emitted when the creation of a connection fails.
 * @argument error CreateConnectionError instance
 */
export const CREATE_FAIL = Symbol('CREATE_FAIL');

/**
 * @event CLOSE_FAIL Emitted when the closing of a connection fails.
 * @argument connection MegaPendingConnection instance
 * @argument error CloseConnectionError instance
 */
export const CLOSE_FAIL = Symbol('CLOSE_FAIL');

/**
 * @event TRANSACTION_FAIL Emitted when con.beginTransaction() rejects.
 * @argument error BeginTransactionError instance
 */
export const TRANSACTION_FAIL = Symbol('TRANSACTION_FAIL');

/**
 * @event COMMIT_FAIL Emitted when con.commit() rejects.
 * @argument error CommitTransactionError instance
 */
export const COMMIT_FAIL = Symbol('COMMIT_FAIL');

/**
 * @event ROLLBACK_FAIL Emitted when con.rollback() rejects.
 * @argument error RollbackTransactionError instance
 */
export const ROLLBACK_FAIL = Symbol('ROLLBACK_FAIL');

/**
 * @event SHUTDOWN_FAIL Emitted when the shutdown process of the pool fails.
 * @argument error ShutdownError instance
 */
export const SHUTDOWN_FAIL = Symbol('SHUTDOWN_FAIL');

/**
 * @event QUERY_SUCCESS Emitted when a query execution succeeds.
 * @argument result MegaQueryResult
 */
export const QUERY_SUCCESS = Symbol('QUERY_SUCCESS');

/**
 * @event CREATE_SUCCESS Emitted when the creation of a connection succeeds.
 * @argument connection MegaPoolConnection instance
 */
export const CREATE_SUCCESS = Symbol('CREATE_SUCCESS');

/**
 * @event CLOSE_SUCCESS Emitted when the closing of a connection succeeds.
 * @argument result void
 */
export const CLOSE_SUCCESS = Symbol('CLOSE_SUCCESS');

/**
 * @event TRANSACTION_SUCCESS Emitted when con.beginTransaction() resolves.
 * @argument result void
 */
export const TRANSACTION_SUCCESS = Symbol('TRANSACTION_SUCCESS');

/**
 * @event COMMIT_SUCCESS Emitted when con.commit() resolves.
 * @argument result void
 */
export const COMMIT_SUCCESS = Symbol('COMMIT_SUCCESS');

/**
 * @event ROLLBACK_SUCCESS Emitted when con.rollback() resolves.
 * @argument result void
 */
export const ROLLBACK_SUCCESS = Symbol('ROLLBACK_SUCCESS');

/**
 * @event SHUTDOWN_SUCCESS Emitted when the shutdown process of the pool succeeds.
 * @argument result void
 */
export const SHUTDOWN_SUCCESS = Symbol('SHUTDOWN_SUCCESS');

/**
 * @event MAX_QUEUE_TIME Emitted when the maximum allowed queue time for connection requests is reached.
 * @argument error MaxQueueTimeError instance
 */
export const MAX_QUEUE_TIME = Symbol('MAX_QUEUE_TIME');

/**
 * @event MAX_QUEUE_SIZE Emitted when the maximum allowed queue size for connection requests is reached.
 * @argument error MaxQueueSizeError instance
 */
export const MAX_QUEUE_SIZE = Symbol('MAX_QUEUE_SIZE');

/**
 * @event MAX_CONNECTION Emitted when the maximum number of allowed connections in the pool is reached.
 * @argument error MaxConnectionError instance
 */
export const MAX_CONNECTION = Symbol('MAX_CONNECTION');

/**
 * @event RELEASED Emitted after a connection is released back to the pool.
 * @argument connection MegaPoolConnection instance
 */
export const RELEASED = Symbol('RELEASED');

/**
 * Custom error class for handling Mega pool-related errors.
 */
export class MegaPoolError extends Error {}

/**
 * MegaPool is a connection pool management system that handles the creation, management,
 * and termination of database connections. It provides methods to execute queries,
 * manage transactions, and emit events for connection-related activities.
 *
 * @class `MegaPool`
 */
export class MegaPool extends EventEmitter {
  /**
   * The pool identifier
   */
  public id: Symbol;

  /**
   * The created at timestamp
   */
  public createdAt: string;

  /**
   * The pool driver we use to create connections
   */
  private driver: MegaDriver;

  /**
   * The echo instance i use to retry creation and closing of connections
   */
  private echo: Echo;

  /**
   * The pool configuration options
   */
  private options: MegaPoolOptions;

  /**
   * The connections free to use
   */
  private idleConnections: Array<IdleConnection>;

  /**
   * The connections in use
   */
  private acquiredConnections: Array<AcquiredConnection>;

  /**
   * The queue of connection requests
   */
  private connectionRequests: Array<ConnectionRequest>;

  /**
   * Creates a new instance of MegaPool.
   *
   * @param driver - The driver instance used to create connections.
   * @param options - Pool configuration options.
   */
  constructor(driver: MegaDriver, options?: MegaPoolOptions) {
    super();

    if (!isDriver(driver)) {
      throw new MegaPoolError(`Invalid driver: ${String(driver)}`);
    }

    const clone = isObj(options) ? { ...options } : {};

    if (!isInt(clone.maxConnection) || !(clone.maxConnection > 0)) {
      clone.maxConnection = 10;
    }

    if (!isInt(clone.maxIdleTime) || !(clone.maxIdleTime > 0)) {
      clone.maxIdleTime = 60000; // 1min
    }

    if (!isBool(clone.shouldQueue)) {
      clone.shouldQueue = true; // 1min
    }

    if (!isInt(clone.maxQueueSize) || !(clone.maxQueueSize > 0)) {
      clone.maxQueueSize = Infinity;
    }

    if (!isInt(clone.maxQueueTime) || !(clone.maxQueueTime > 0)) {
      clone.maxQueueTime = 1000; // 1s
    }

    if (!isBool(clone.shouldRetry)) {
      clone.shouldRetry = true;
    }

    if (!isInt(clone.maxRetry) || !(clone.maxRetry > 0)) {
      clone.maxRetry = 3;
    }

    if (!isInt(clone.retryDelay) || !(clone.retryDelay > 0)) {
      clone.retryDelay = 500;
    }

    if (!isInt(clone.extraDelay) || !(clone.extraDelay >= 0)) {
      clone.extraDelay = 500;
    }

    this.driver = driver;
    this.options = clone;
    this.id = Symbol('MegaPool');
    this.createdAt = UTC.get.datetime();

    this.acquiredConnections = new Array();
    this.idleConnections = new Array();
    this.connectionRequests = new Array();

    this.echo = new Echo(
      this.options.maxRetry,
      this.options.retryDelay,
      this.options.extraDelay
    );
  }

  /**
   * Close the given connection
   * @param connection The connection to be closed
   * @returns Promise resolves if the connection is closed successfully
   * @private This method is private
   */
  private closeConnection(connection: MegaConnection): Promise<void> {
    return new Promise((resolve, reject) => {
      connection
        .close()
        .then(() => {
          this.emit(CLOSE_SUCCESS);
          resolve();
        })
        .catch((error) => {
          if (!this.options.shouldRetry) {
            this.emit(CLOSE_FAIL, createPendingConnection(connection), error);
            reject(error);
          }

          this.echo
            .retry<void>(connection.close.bind(connection))
            .then(() => {
              this.emit(CLOSE_SUCCESS);
              resolve();
            })
            .catch((error) => {
              this.emit(CLOSE_FAIL, createPendingConnection(connection), error);

              reject(error);
            });
        });
    });
  }

  /**
   * Create a new connection
   * @returns Promise resolves with the created connection
   * @private This method is private
   */
  private createConnection(): Promise<AcquiredConnection> {
    return new Promise((resolve, reject) => {
      return this.driver
        .create()
        .then((inner) => {
          const outter = createPoolConnection(this, inner);
          this.emit(CREATE_SUCCESS, outter);
          return resolve({ inner, outter });
        })
        .catch((error) => {
          if (!this.options.shouldRetry) {
            this.emit(CREATE_FAIL, error);
            return reject(error);
          }

          return this.echo
            .retry<MegaConnection>(this.driver.create.bind(this.driver))
            .then((inner) => {
              const outter = createPoolConnection(this, inner);
              this.emit(CREATE_SUCCESS, outter);
              return resolve({ inner, outter });
            })
            .catch((error) => {
              this.emit(CREATE_FAIL, error);
              return reject(error);
            });
        });
    });
  }

  /**
   * Release the given connection.
   *
   * @param connection - Instance of MegaPoolConnection to release.
   *
   * @note Once you release a connection back to the pool, you can no longer use it.
   * @note Once you release a connection, it becomes idle.
   * @note Once you release a connection, it becomes the resolve value of another request (if shouldQueue is true).
   * @note Make sure to release the connection; otherwise, the shutdown of the pool will fail.
   */
  public release(connection: MegaPoolConnection): void {
    if (!isPoolCon(connection)) {
      throw new MegaPoolError(`Invalid connection: ${connection}`);
    }

    const inner = this.acquiredConnections.find(
      (i) => i.outter === connection
    )?.inner;

    if (isUndefined(inner)) {
      throw new MegaPoolError(`Undefined connection: ${connection}`);
    }

    const reject = () => {
      return Promise.reject(
        new MegaPoolError(
          `Can't perform any farther operations after releasing connections`
        )
      );
    };

    const fail = () => {
      throw new MegaPoolError(
        `Can't perform any farther operations after releasing connections`
      );
    };

    connection.release = fail;
    connection.query = reject;
    connection.commit = reject;
    connection.rollback = reject;
    connection.beginTransaction = reject;

    // emit RELASED event
    this.emit(RELEASED, connection);

    // clear acquired connection
    this.acquiredConnections = this.acquiredConnections.filter(
      (i) => i.outter !== connection
    );

    // in case we have a connection request => resolve
    if (this.connectionRequests.length > 0) {
      const { resolve, id } = this.connectionRequests.shift();
      clearTimeout(id); // clear time out

      const outter = createPoolConnection(this, inner);
      this.acquiredConnections.push({ outter, inner });
      return resolve(outter); // resolve with a new connection
    }

    // in case we have no connection requests => register idle connection
    const id = setTimeout(() => {
      this.idleConnections = this.idleConnections.filter(
        (con) => con.connection !== inner
      );

      // Close the connection and catch any errors
      this.closeConnection(inner).catch(() => {});
    }, this.options.maxIdleTime);

    this.idleConnections.push({ id, connection: inner });
  }

  /**
   * Request a connection from the pool
   * @returns Promise resolves with a connection
   * @throws `MaxQueueTimeError` when the connection request exceeds the maximum queue time.
   * @throws `MaxQueueSizeError` when the maximum queue size is passed.
   * @throws `MaxConnectionError` when the maximum number of connections is exceeded.
   *
   * @note If the pool has idle connections, one will be provided.
   * @note If no idle connection is available, a new connection will be created.
   * @note If the `maxConnection` reached, the request will be queued if `shouldQueue` is true.
   * @note If the queue exceeds maxQueueSize, pool rejects with `MaxQueueSizeError`.
   * @note If a request remains in the queue longer than maxQueueTime, pool rejects with `MaxQueueTimeError`.
   * @note If `maxConnection` rached and `shouldQueue` is false, pool rejects with `MaxConnectionError`
   */
  public request(): Promise<MegaPoolConnection> {
    return new Promise((resolve, reject) => {
      if (this.has.idle()) {
        const { connection, id } = this.idleConnections.shift();
        clearTimeout(id);

        return connection
          .query('SELECT 1;') // Check connection
          .then(() => {
            const inner = connection;
            const outter = createPoolConnection(this, inner);

            this.acquiredConnections.push({ inner, outter });
            resolve(outter);
          })
          .catch(() => {
            return this.closeConnection(connection)
              .then(() =>
                this.createConnection()
                  .then((connection) => {
                    this.acquiredConnections.push(connection);
                    resolve(connection.outter);
                  })
                  .catch(reject)
              )
              .catch(reject);
          });
      }

      const TOTAL = this.get.count.idle() + this.get.count.acquired();
      // Create a connection if TOTAL less than maxConnections
      if (TOTAL < this.options.maxConnection) {
        return this.createConnection()
          .then((connection) => {
            this.acquiredConnections.push(connection);
            resolve(connection.outter);
          })
          .catch(reject);
      }

      if (this.options.shouldQueue) {
        if (this.connectionRequests.length < this.options.maxQueueSize) {
          const id = setTimeout(() => {
            this.connectionRequests = this.connectionRequests.filter(
              (request) => request.id !== id
            );

            this.emit(MAX_QUEUE_TIME, new MaxQueueTimeError());
            reject(new MaxQueueTimeError());
          }, this.options.maxQueueTime);

          return this.connectionRequests.push({ id, resolve });
        }

        this.emit(MAX_QUEUE_SIZE, new MaxQueueSizeError());
        return reject(new MaxQueueSizeError());
      }

      this.emit(MAX_CONNECTION, new MaxConnectionError());
      reject(new MaxConnectionError());
    });
  }

  /**
   * Executes the given SQL statement.
   *
   * @param sql - The SQL query string to execute.
   * @param values - Optional array of values for SQL parameters.
   *
   * @returns A promise that resolves with the expected result of the query.
   *
   * @note This method acquires a connection from the pool and releases it afterward.
   * @note If the query fails, the connection is still released back to the pool.
   */
  public query(
    sql: string,
    values?: Array<string | number>
  ): Promise<MegaQueryResult> {
    return new Promise((resolve, reject) => {
      this.request()
        .then((connection) => {
          connection
            .query(sql, values)
            .then((result) => {
              this.release(connection);
              return resolve(result);
            })
            .catch((error) => {
              this.release(connection);
              return reject(error);
            });
        })
        .catch(reject);
    });
  }

  /**
   * Shuts down the pool by closing all connections and dereferencing values.
   *
   * @returns A promise that resolves when the shutdown operation completes successfully.
   *
   * @note This method will reject if:
   * - There are pending connection requests in the pool that haven't been fulfilled.
   * - There are unreleased connections that haven't been returned to the pool.
   *
   * @note Ensure you handle the `CLOSE_FAIL` event and register any
   * `MegaPendingConnection` for later closing attempts.
   *
   * @note Once the shutdown resolves, the pool can no longer be used
   * because it becomes a dummy pool.
   */
  public shutdown(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connectionRequests.length !== 0) {
        const error = new ShutdownError(
          `Cannot shut down: Connection requests must be stopped first`
        );

        this.emit(SHUTDOWN_FAIL, error);
        return reject(error);
      }

      if (this.acquiredConnections.length !== 0) {
        const error = new ShutdownError(
          `Cannot shut down: All connections must be released before shutdown`
        );

        this.emit(SHUTDOWN_FAIL, error);
        return reject(error);
      }

      const clean = () => {
        function reject(): any {
          return Promise.reject(
            new MegaPoolError(
              `Can't perform any farther operations after shutdown`
            )
          );
        }

        function fail(): any {
          throw new MegaPoolError(
            `Can't perform any farther operations after shutdown`
          );
        }

        this.id = null;
        this.createdAt = null;
        this.options = null;
        this.idleConnections = null;
        this.connectionRequests = null;
        this.acquiredConnections = null;
        this.driver = null;
        this.echo = null;
        this.get.count.acquired = fail;
        this.get.count.idle = fail;
        this.get.count.request = fail;
        this.get.driver = fail;
        this.get.options = fail;
        this.get.performance = fail;
        this.has.acquired = fail;
        this.has.idle = fail;
        this.has.request = fail;
        this.removeAllListeners();
        this.closeConnection = reject;
        this.createConnection = reject;
        this.request = reject;
        this.query = reject;
        this.shutdown = reject;
        this.release = fail;
      };

      Promise.allSettled(
        this.idleConnections.map((con) => {
          const { connection, id } = con;
          clearTimeout(id);

          return this.closeConnection(connection);
        })
      ).then(() => {
        this.emit(SHUTDOWN_SUCCESS);
        clean();
        resolve();
      });
    });
  }

  /**
   * Retrieves information about the current state of the pool.
   */
  public get: Getter = {
    count: {
      acquired: (): number => this.acquiredConnections.length,
      idle: (): number => this.idleConnections.length,
      request: (): number => this.connectionRequests.length,
    },
    options: (): MegaPoolOptions => ({
      ...this.options,
    }),
    driver: () => this.driver,
    performance: (): Symbol => {
      function getPercentage(percentageValue: number, number: number): number {
        return (percentageValue / 100) * number;
      }

      const _80Persent = getPercentage(
        80,
        this.options.maxConnection as number
      );

      const _50Persent = getPercentage(
        50,
        this.options.maxConnection as number
      );

      const aquired = this.get.count.acquired();

      if (aquired >= _80Persent) return BAD_POOL;
      if (aquired >= _50Persent) return GOOD_POOL;
      return GREAT_POOL;
    },
  };

  /**
   * Checks the status of connections in the pool.
   */
  public has: Checker = {
    acquired: (): boolean => this.acquiredConnections.length > 0,
    idle: (): boolean => this.idleConnections.length > 0,
    request: (): boolean => this.connectionRequests.length > 0,
  };
}
