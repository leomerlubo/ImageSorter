const FIREBASE_IMPORT_PROJECT_ID = 'paa-website-image-sorter';
const FIREBASE_IMPORT_BATCH_SIZE = 250;
const FIREBASE_IMPORT_TRIGGER_FUNCTION = 'continueFirebaseImportAutomatically';

function startFirebaseImportAutomation() {
  resetFirebaseImportProgress();
  deleteFirebaseImportTriggers_();

  PropertiesService.getScriptProperties().setProperty('FIREBASE_IMPORT_RUNNING', 'true');

  ScriptApp.newTrigger(FIREBASE_IMPORT_TRIGGER_FUNCTION)
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('Firebase automatic import started.');
  Logger.log('A trigger will run every minute until the import is complete.');

  continueFirebaseImportAutomatically();
}

function continueFirebaseImportAutomatically() {
  const props = PropertiesService.getScriptProperties();
  const isRunning = props.getProperty('FIREBASE_IMPORT_RUNNING');

  if (isRunning !== 'true') {
    Logger.log('Firebase import is not marked as running. Stopping.');
    deleteFirebaseImportTriggers_();
    return;
  }

  const startRow = Number(props.getProperty('FIREBASE_IMPORT_NEXT_ROW') || 2);

  const result = importImagesSheetToFirebaseFromRow_(startRow);

  if (result && result.done === true) {
    props.deleteProperty('FIREBASE_IMPORT_RUNNING');
    props.deleteProperty('FIREBASE_IMPORT_NEXT_ROW');
    deleteFirebaseImportTriggers_();

    Logger.log('Firebase automatic import is complete.');
    Logger.log('All import triggers were removed.');
  }
}

function stopFirebaseImportAutomation() {
  PropertiesService.getScriptProperties().deleteProperty('FIREBASE_IMPORT_RUNNING');
  deleteFirebaseImportTriggers_();

  Logger.log('Firebase automatic import was stopped.');
}

function resetFirebaseImportProgress() {
  const props = PropertiesService.getScriptProperties();

  props.deleteProperty('FIREBASE_IMPORT_NEXT_ROW');
  props.deleteProperty('FIREBASE_IMPORT_RUNNING');

  Logger.log('Firebase import progress was reset. Next import will start from row 2.');
}

function importImagesSheetToFirebase() {
  const props = PropertiesService.getScriptProperties();
  const startRow = Number(props.getProperty('FIREBASE_IMPORT_NEXT_ROW') || 2);

  return importImagesSheetToFirebaseFromRow_(startRow);
}

function importImagesSheetToFirebaseFromBeginning() {
  PropertiesService.getScriptProperties().deleteProperty('FIREBASE_IMPORT_NEXT_ROW');

  return importImagesSheetToFirebaseFromRow_(2);
}

function importImagesSheetToFirebaseFromRow_(startRow) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('Images');

  if (!sheet) {
    throw new Error('Images sheet was not found.');
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    Logger.log('No rows found to import.');

    return {
      done: true,
      imported: 0,
      skipped: 0,
      nextRow: null
    };
  }

  if (startRow > lastRow) {
    PropertiesService.getScriptProperties().deleteProperty('FIREBASE_IMPORT_NEXT_ROW');

    Logger.log('Firebase import is already complete.');
    Logger.log('Last row in Images sheet: ' + lastRow);

    return {
      done: true,
      imported: 0,
      skipped: 0,
      nextRow: null
    };
  }

  const numberOfRows = Math.min(
    FIREBASE_IMPORT_BATCH_SIZE,
    lastRow - startRow + 1
  );

  const values = sheet.getRange(startRow, 1, numberOfRows, 33).getValues();

  let imported = 0;
  let skipped = 0;

  values.forEach(function(row, index) {
    const sheetRowNumber = startRow + index;

    const sku = String(row[0] || '').trim();
    const description = String(row[1] || '').trim();

    if (!sku) {
      skipped++;
      return;
    }

    if (sku.toLowerCase() === 'placeholder') {
      skipped++;
      return;
    }

    const images = [];

    for (let i = 2; i <= 32; i++) {
      const imageUrl = String(row[i] || '').trim();

      if (imageUrl) {
        images.push(imageUrl);
      }
    }

    if (images.length < 2) {
      skipped++;
      return;
    }

    const doc = {
      fields: {
        sku: {
          stringValue: sku
        },
        description: {
          stringValue: description
        },
        images: {
          arrayValue: {
            values: images.map(function(url) {
              return {
                stringValue: url
              };
            })
          }
        },
        status: {
          stringValue: 'available'
        },
        lockedByEmail: {
          stringValue: ''
        },
        lockedAt: {
          nullValue: null
        },
        expiresAt: {
          nullValue: null
        },
        completedByEmail: {
          stringValue: ''
        },
        completedAt: {
          nullValue: null
        },
        selectedImages: {
          arrayValue: {
            values: []
          }
        },
        skipped: {
          booleanValue: false
        },
        sourceRowNumber: {
          integerValue: String(sheetRowNumber)
        },
        importedAt: {
          timestampValue: new Date().toISOString()
        }
      }
    };

    upsertFirestoreDocument_('tasks', sku, doc);

    imported++;
  });

  const nextRow = startRow + numberOfRows;

  if (nextRow <= lastRow) {
    PropertiesService.getScriptProperties().setProperty(
      'FIREBASE_IMPORT_NEXT_ROW',
      String(nextRow)
    );

    Logger.log('Firebase import batch complete.');
    Logger.log('Rows processed: ' + startRow + ' to ' + (nextRow - 1));
    Logger.log('Imported tasks in this batch: ' + imported);
    Logger.log('Skipped rows in this batch: ' + skipped);
    Logger.log('Next row to import: ' + nextRow);

    return {
      done: false,
      imported: imported,
      skipped: skipped,
      nextRow: nextRow
    };
  }

  PropertiesService.getScriptProperties().deleteProperty('FIREBASE_IMPORT_NEXT_ROW');

  Logger.log('Firebase import complete.');
  Logger.log('Rows processed: ' + startRow + ' to ' + lastRow);
  Logger.log('Imported tasks in this batch: ' + imported);
  Logger.log('Skipped rows in this batch: ' + skipped);
  Logger.log('No more rows to import.');

  return {
    done: true,
    imported: imported,
    skipped: skipped,
    nextRow: null
  };
}

function upsertFirestoreDocument_(collectionId, documentId, payload) {
  const encodedDocumentId = encodeURIComponent(documentId);

  const url =
    'https://firestore.googleapis.com/v1/projects/' +
    FIREBASE_IMPORT_PROJECT_ID +
    '/databases/(default)/documents/' +
    collectionId +
    '/' +
    encodedDocumentId;

  const token = ScriptApp.getOAuthToken();

  const response = UrlFetchApp.fetch(url, {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token
    },
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

function deleteFirebaseImportTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === FIREBASE_IMPORT_TRIGGER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}