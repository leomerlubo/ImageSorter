const FIREBASE_PROJECT_ID = 'paa-website-image-sorter';

const CONFIG = {
  totalSkus: 37892,
  minutesPerTask: 2,
  taskCollection: 'tasks',
  settingsCollection: 'settings',
  settingsDoc: 'app',
  userStatsCollection: 'userStats'
};

function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('Park Avenue Appliance Image order on PP');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Park Avenue Appliance')
    .addItem('Open Tool', 'showImageOrganizer')
    .addItem('Release Expired Firebase Tasks', 'releaseExpiredLocks')
    .addItem('Refresh Firebase Report', 'createReportTabNow')
    .addToUi();
}

function showImageOrganizer() {
  const html = HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('Park Avenue Appliance Image order on PP');

  SpreadsheetApp.getUi().showSidebar(html);
}

function getUserEmail() {
  const activeEmail = Session.getActiveUser().getEmail();
  const effectiveEmail = Session.getEffectiveUser().getEmail();

  return normalizeEmail_(activeEmail || effectiveEmail || 'unknown');
}

function getWorkerEmail_(providedEmail) {
  const cleanProvided = normalizeEmail_(providedEmail);

  if (cleanProvided && cleanProvided.indexOf('@') > -1) {
    return cleanProvided;
  }

  return getUserEmail();
}

function normalizeEmail_(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function runWithScriptLock(callback) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(28000);
  } catch (err) {
    throw new Error(
      'Another person is saving or loading tasks right now. Please wait a few seconds and try again.'
    );
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function getNextBatch(limit, sessionId, workerEmailFromClient) {
  return runWithScriptLock(() => {
    const settings = getFirebaseSettings_();
    const workerEmail = getWorkerEmail_(workerEmailFromClient);
    const now = new Date();

    limit = Number(limit || 10);

    releaseExpiredFirebaseLocks_();

    const availableTasks = queryTasksByStatus_('available', limit * 4);

    const batch = [];

    for (let i = 0; i < availableTasks.length; i++) {
      if (batch.length >= limit) {
        break;
      }

      const task = availableTasks[i];

      if (!task.id || !task.sku) {
        continue;
      }

      const images = Array.isArray(task.images) ? task.images : [];

      if (images.length < 2) {
        updateTask_(task.id, {
          status: 'done',
          skipped: true,
          completedByEmail: 'system',
          completedAt: new Date(),
          lockedByEmail: '',
          lockedAt: null,
          expiresAt: null
        });

        continue;
      }

      const lockExpiresAt = new Date(
        now.getTime() + settings.minutesPerTask * 60 * 1000
      );

      const latestTask = getTask_(task.id);

      if (!latestTask || latestTask.status !== 'available') {
        continue;
      }

      updateTask_(task.id, {
        status: 'in_progress',
        lockedByEmail: workerEmail,
        lockedAt: now,
        expiresAt: lockExpiresAt
      });

      batch.push({
        rowNumber: task.id,
        sku: task.sku,
        description: task.description || '',
        images: images
      });
    }

    return batch;
  });
}

function saveBatchResults(data) {
  return runWithScriptLock(() => {
    const workerEmail = getWorkerEmail_(data && data.workerEmail);
    const results = data && data.results ? data.results : [];

    let newlyCompletedCount = 0;

    results.forEach(item => {
      const taskId = String(item.rowNumber || item.sku || '').trim();

      if (!taskId) {
        return;
      }

      const selectedImages = item.selectedImages || [];
      const skipped = item.skipped === true;

      const task = getTask_(taskId);

      if (!task) {
        return;
      }

      if (task.status === 'done') {
        return;
      }

      const lockedByEmail = normalizeEmail_(task.lockedByEmail);

      if (lockedByEmail && lockedByEmail !== workerEmail) {
        return;
      }

      if (skipped || selectedImages.length > 0) {
        updateTask_(taskId, {
          status: 'done',
          completedByEmail: workerEmail,
          completedAt: new Date(),
          selectedImages: selectedImages,
          skipped: skipped,
          lockedByEmail: '',
          lockedAt: null,
          expiresAt: null
        });

        newlyCompletedCount++;
        return;
      }

      updateTask_(taskId, {
        status: 'available',
        lockedByEmail: '',
        lockedAt: null,
        expiresAt: null
      });
    });

    if (newlyCompletedCount > 0) {
      incrementUserStats_(workerEmail, newlyCompletedCount);
    }

    return true;
  });
}

function releaseSessionLocks(sessionId, workerEmailFromClient) {
  return runWithScriptLock(() => {
    const workerEmail = getWorkerEmail_(workerEmailFromClient);

    const lockedTasks = queryTasksByStatusAndEmail_(
      'in_progress',
      workerEmail,
      500
    );

    lockedTasks.forEach(task => {
      updateTask_(task.id, {
        status: 'available',
        lockedByEmail: '',
        lockedAt: null,
        expiresAt: null
      });
    });

    return true;
  });
}

function releaseExpiredLocks() {
  return runWithScriptLock(() => {
    return releaseExpiredFirebaseLocks_();
  });
}

function releaseExpiredFirebaseLocks_() {
  const now = new Date();

  const inProgressTasks = queryTasksByStatus_('in_progress', 500);

  let released = 0;

  inProgressTasks.forEach(task => {
    const expiresAt = task.expiresAt ? new Date(task.expiresAt) : null;

    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      updateTask_(task.id, {
        status: 'available',
        lockedByEmail: '',
        lockedAt: null,
        expiresAt: null
      });

      released++;
    }
  });

  return released;
}

function getProgressReport() {
  const settings = getFirebaseSettings_();

  const stats = queryUserStats_();

  let totalCompleted = 0;

  const users = stats.map(item => {
    const completedCount = Number(item.completedCount || 0);

    totalCompleted += completedCount;

    return {
      email: item.email || item.id,
      alias: item.alias || '',
      displayName: item.alias || item.email || item.id,
      uniqueSkuCount: completedCount,
      contributionPercent:
        settings.totalSkus > 0
          ? completedCount / settings.totalSkus * 100
          : 0
    };
  });

  users.sort((a, b) => {
    if (b.uniqueSkuCount !== a.uniqueSkuCount) {
      return b.uniqueSkuCount - a.uniqueSkuCount;
    }

    return a.displayName.localeCompare(b.displayName);
  });

  return {
    totalSkus: settings.totalSkus,
    totalCompletedUniqueSkus: totalCompleted,
    overallCompletionPercent:
      settings.totalSkus > 0
        ? totalCompleted / settings.totalSkus * 100
        : 0,
    users: users
  };
}

function exportCompletedTasksCsv() {
  const doneTasks = queryTasksByStatus_('done', 50000);

  const rows = [
    [
      'Handle',
      'Image Src',
      'Image Position',
      'Created By Email'
    ]
  ];

  doneTasks.forEach(task => {
    const sku = String(task.sku || task.id || '').trim();
    const email = normalizeEmail_(task.completedByEmail);
    const selectedImages = Array.isArray(task.selectedImages)
      ? task.selectedImages
      : [];

    if (!sku || !email || selectedImages.length === 0) {
      return;
    }

    selectedImages.forEach((url, index) => {
      const cleanUrl = String(url || '').trim();

      if (!cleanUrl) {
        return;
      }

      rows.push([
        sku,
        cleanUrl,
        index + 1,
        email
      ]);
    });
  });

  return rows.map(row => {
    return row.map(value => {
      const text = String(value === null || value === undefined ? '' : value);

      if (
        text.indexOf(',') > -1 ||
        text.indexOf('"') > -1 ||
        text.indexOf('\n') > -1 ||
        text.indexOf('\r') > -1
      ) {
        return '"' + text.replace(/"/g, '""') + '"';
      }

      return text;
    }).join(',');
  }).join('\n');
}

function getFirebaseSettings_() {
  const doc = getFirestoreDocument_(
    CONFIG.settingsCollection,
    CONFIG.settingsDoc
  );

  if (!doc) {
    return {
      totalSkus: CONFIG.totalSkus,
      minutesPerTask: CONFIG.minutesPerTask
    };
  }

  return {
    totalSkus: Number(doc.totalSkus || CONFIG.totalSkus),
    minutesPerTask: Number(doc.minutesPerTask || CONFIG.minutesPerTask)
  };
}

function getTask_(taskId) {
  return getFirestoreDocument_(CONFIG.taskCollection, taskId);
}

function updateTask_(taskId, data) {
  return patchFirestoreDocument_(CONFIG.taskCollection, taskId, data);
}

function incrementUserStats_(email, amount) {
  const cleanEmail = normalizeEmail_(email);
  const current = getFirestoreDocument_(CONFIG.userStatsCollection, cleanEmail);

  const currentCount = current
    ? Number(current.completedCount || 0)
    : 0;

  const nextCount = currentCount + Number(amount || 0);

  return patchFirestoreDocument_(CONFIG.userStatsCollection, cleanEmail, {
    email: cleanEmail,
    completedCount: nextCount,
    updatedAt: new Date()
  });
}

function queryTasksByStatus_(status, limit) {
  const query = {
    structuredQuery: {
      from: [
        {
          collectionId: CONFIG.taskCollection
        }
      ],
      where: {
        fieldFilter: {
          field: {
            fieldPath: 'status'
          },
          op: 'EQUAL',
          value: {
            stringValue: status
          }
        }
      },
      limit: Number(limit || 100)
    }
  };

  return runFirestoreQuery_(query);
}

function queryTasksByStatusAndEmail_(status, email, limit) {
  const query = {
    structuredQuery: {
      from: [
        {
          collectionId: CONFIG.taskCollection
        }
      ],
      where: {
        compositeFilter: {
          op: 'AND',
          filters: [
            {
              fieldFilter: {
                field: {
                  fieldPath: 'status'
                },
                op: 'EQUAL',
                value: {
                  stringValue: status
                }
              }
            },
            {
              fieldFilter: {
                field: {
                  fieldPath: 'lockedByEmail'
                },
                op: 'EQUAL',
                value: {
                  stringValue: normalizeEmail_(email)
                }
              }
            }
          ]
        }
      },
      limit: Number(limit || 100)
    }
  };

  return runFirestoreQuery_(query);
}

function queryUserStats_() {
  const query = {
    structuredQuery: {
      from: [
        {
          collectionId: CONFIG.userStatsCollection
        }
      ],
      limit: 500
    }
  };

  return runFirestoreQuery_(query);
}

function getFirestoreDocument_(collectionId, documentId) {
  const encodedCollectionId = encodeURIComponent(collectionId);
  const encodedDocumentId = encodeURIComponent(documentId);

  const url =
    'https://firestore.googleapis.com/v1/projects/' +
    FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/' +
    encodedCollectionId +
    '/' +
    encodedDocumentId;

  const response = firebaseFetch_(url, {
    method: 'get',
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();

  if (code === 404) {
    return null;
  }

  if (code < 200 || code >= 300) {
    throw new Error(
      'Firestore read failed for ' +
      collectionId +
      '/' +
      documentId +
      ': ' +
      response.getContentText()
    );
  }

  const json = JSON.parse(response.getContentText());

  return parseFirestoreDocument_(json);
}

function patchFirestoreDocument_(collectionId, documentId, data) {
  const encodedCollectionId = encodeURIComponent(collectionId);
  const encodedDocumentId = encodeURIComponent(documentId);

  const fields = {};
  const masks = [];

  Object.keys(data).forEach(key => {
    fields[key] = toFirestoreValue_(data[key]);
    masks.push('updateMask.fieldPaths=' + encodeURIComponent(key));
  });

  const url =
    'https://firestore.googleapis.com/v1/projects/' +
    FIREBASE_PROJECT_ID +
    '/databases/(default)/documents/' +
    encodedCollectionId +
    '/' +
    encodedDocumentId +
    '?' +
    masks.join('&');

  const payload = {
    fields: fields
  };

  const response = firebaseFetch_(url, {
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();

  if (code < 200 || code >= 300) {
    throw new Error(
      'Firestore write failed for ' +
      collectionId +
      '/' +
      documentId +
      ': ' +
      response.getContentText()
    );
  }

  return JSON.parse(response.getContentText());
}

function runFirestoreQuery_(queryBody) {
  const url =
    'https://firestore.googleapis.com/v1/projects/' +
    FIREBASE_PROJECT_ID +
    '/databases/(default)/documents:runQuery';

  const response = firebaseFetch_(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(queryBody),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();

  if (code < 200 || code >= 300) {
    throw new Error(
      'Firestore query failed: ' + response.getContentText()
    );
  }

  const json = JSON.parse(response.getContentText());

  const results = [];

  json.forEach(item => {
    if (item.document) {
      results.push(parseFirestoreDocument_(item.document));
    }
  });

  return results;
}

function firebaseFetch_(url, options) {
  options = options || {};
  options.headers = options.headers || {};
  options.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();

  return UrlFetchApp.fetch(url, options);
}

function parseFirestoreDocument_(document) {
  const data = {};

  const nameParts = String(document.name || '').split('/');
  data.id = decodeURIComponent(nameParts[nameParts.length - 1]);

  const fields = document.fields || {};

  Object.keys(fields).forEach(key => {
    data[key] = fromFirestoreValue_(fields[key]);
  });

  return data;
}

function toFirestoreValue_(value) {
  if (value === null || value === undefined) {
    return {
      nullValue: null
    };
  }

  if (value instanceof Date) {
    return {
      timestampValue: value.toISOString()
    };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(item => toFirestoreValue_(item))
      }
    };
  }

  if (typeof value === 'boolean') {
    return {
      booleanValue: value
    };
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return {
        integerValue: String(value)
      };
    }

    return {
      doubleValue: value
    };
  }

  return {
    stringValue: String(value)
  };
}

function fromFirestoreValue_(value) {
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }

  if (value.integerValue !== undefined) {
    return Number(value.integerValue);
  }

  if (value.doubleValue !== undefined) {
    return Number(value.doubleValue);
  }

  if (value.booleanValue !== undefined) {
    return value.booleanValue;
  }

  if (value.timestampValue !== undefined) {
    return value.timestampValue;
  }

  if (value.nullValue !== undefined) {
    return null;
  }

  if (value.arrayValue !== undefined) {
    const values = value.arrayValue.values || [];

    return values.map(item => fromFirestoreValue_(item));
  }

  if (value.mapValue !== undefined) {
    const map = {};
    const fields = value.mapValue.fields || {};

    Object.keys(fields).forEach(key => {
      map[key] = fromFirestoreValue_(fields[key]);
    });

    return map;
  }

  return null;
}

function createReportTabNow() {
  const summary = getProgressReport();

  Logger.log('Firebase progress report refreshed.');
  Logger.log(JSON.stringify(summary, null, 2));

  return summary;
}