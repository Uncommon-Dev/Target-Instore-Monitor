// Dependencies
const fs = require("fs");
const ini = require("ini");
const { Webhook, MessageBuilder } = require("discord-webhook-node");
const { convertCSVToArray } = require("convert-csv-to-array");
const got = require('got');
var inquirer = require('inquirer');
const prompt = require('prompt-sync')();
const perf = require('execution-time')();
const mysql = require('mysql');
const async = require('async');
const { parse } = require("path");
const pool = mysql.createPool({
  connectionLimit : 100,
  host: 'localhost',
  port: 3306,
  user: 'XXXXXX',
  password: 'XXXXXX',
  database: 'instore_target_monitor'
});

const parsedConfig = parseConfig();
let hookObject = {};
for(var key in parsedConfig['webhooks']) {
   hookObject[key] = new Webhook(parsedConfig['webhooks'][key]);
}

/*
   -----------------------
   -----------------------
*/

mainMenu();

async function mainMenu() {
  const prompt = await getPrompt();
  inquirer.prompt([{
      type: 'list',
      name: prompt,
      choices: [
        { name: 'Start Script' }
      ],
    },
  ])
  .then((answers) => {
    doNext(prompt, answers);
  });
}

async function doNext(query, answers) {
  if (answers[query] == 'Start Script') {
      main();
    }
}

/*
   -----------------------
   -----------------------
*/

let flag = 'ready';
async function main() {
  try {
    while (true) {
      if(flag === 'ready') {
        flag = 'busy';
        perf.start();
        console.log(getTime() + 'Generating tickets');
        let unparsedTasks = [];
        let id = 0;
        let items = Object.keys(parsedConfig.items);
        for(var item = 0; item < items.length; item++) {
          let product = convertCSVToArray((parsedConfig.items[items[item]]), { separator: "," })[0]
          for(var storeID = 0; storeID < 3000; storeID++) {
            unparsedTasks.push([id, product, storeID]);
            id++;
          }
        }
        let parsedTasks = unparsedTasks.map(task => {
          return async () => {
            await getStock(task);
          }
        });
        console.log(getTime() + 'Initialized: [' + (perf.stop().time/1000).toFixed(2) + ', ' + unparsedTasks.length + '] [seconds, requests]');
        perf.start();
        async.parallelLimit(parsedTasks, 1, async function (err, result) {
          if (err) {
            console.error('error: ', err)
          } else {
            let timer = perf.stop();
            console.log(getTime() + 'Finished: [' + (timer.time/1000).toFixed(2) + ', ' + ((timer.time/1000)/unparsedTasks.length).toFixed(1) + '] [seconds, seconds p/ request]');
            console.log(getTime() + 'Sleeping 60 seconds before re-initialization');
            await new Promise((resolve) => setTimeout(resolve, 60000));
            flag = 'ready';
          }
        });
      } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    console.log("main() error --> " + error.stack);
  }
}

async function getStock(instructions) {
  try {
    let id = instructions[0];
    let product = instructions[1];
    let storeID = instructions[2];
    console.log(getTime(id) + 'Fetching API');
    let response = await got('https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1?key=ff457966e64d5e877fdbad070f276d18ecec4a01&tcin=' + product[0] + '&store_id=' + storeID + '&store_positions_store_id=' + storeID + '&has_store_positions_store_id=true&pricing_store_id=' + storeID + '', {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
    });
    let parsedResponse = JSON.parse(response.body);
    if(parsedResponse['data']['product']['fulfillment']['store_options'][0]['location_available_to_promise_quantity'] != null) {
      let storeName = parsedResponse['data']['product']['fulfillment']['store_options'][0]['location_name'];
      let storeStock = parsedResponse['data']['product']['fulfillment']['store_options'][0]['location_available_to_promise_quantity'];
      let storeAddr = parsedResponse['data']['product']['fulfillment']['store_options'][0]['location_address'];
      let region = 'unfiltered';
      let storeState = convertCSVToArray(storeAddr, { separator: "," })[0][2];
      for(var area in parsedConfig['regions']) {
        for(var state = 0; state < parsedConfig['regions'][area].length; state++) {
          if(storeState === parsedConfig['regions'][area][state])
            region = area;
       }
      }
      let search = storeName + ' ' + product[0];
      pool.getConnection(async function(err, con) {
        if (err) throw err;
        con.query('select * from stockStatus where storeName = ? and tcin = ?', [storeName, product[0]], function (error, results) {
          if(results != undefined && results.length != 0) {
            if(results[0].availability == 'unnotified' && storeStock > 0) {
              console.log(getTime(id) + search + ' new stock found');
              sendWebhook([product, storeName, storeStock, region, storeAddr]);
              con.query('update stockStatus set availability = "notified" where storeName = ? and tcin = ?', [storeName, product[0]], function (error) { if (error) throw error; });
            } else if(results[0].availability == 'unnotified' && storeStock == 0) {
              console.log(getTime(id) + search + ' item OOS');
            } else if (results[0].availability == 'notified' && storeStock == 0) {
              console.log(getTime(id) + search + ' item OOS -- reset status');
              con.query('update stockStatus set availability = "unnotified" where storeName = ? and tcin = ?', [storeName, product[0]], function (error) { if (error) throw error; });
            } else if (results[0].availability == 'notified' && storeStock > 0) {
              console.log(getTime(id) + search + ' old stock found');
            }
          } else if (results === undefined || results.length == 0) {
            console.log(getTime(id) + search + ' making entry');
            con.query('insert into stockStatus values ("0", "' + storeName + '", "' + product[0] + '", "unnotified")', function (error) { if (error) throw error; });
          }
          con.release();
          if (error) throw error;
          });
        });
      }
      return true;
  } catch (error) {
    console.log("getStock() error --> " + error.message);
    return false;
  }
}

/*
   -----------------------
   -----------------------
*/

//Functions - Misc
function parseConfig() {
    const configFile = fs.readFileSync("./config.ini", "utf-8");
    const parsedConfig = ini.parse(configFile);
    for(var key in parsedConfig['regions']) {
      if((parsedConfig['regions'][key].match(/,/g)||[]).length >= 1) {
        parsedConfig['regions'][key] = convertCSVToArray(parsedConfig['regions'][key])[0];
      } else {
        parsedConfig['regions'][key] = [parsedConfig['regions'][key]];
      }
    }  
    return parsedConfig;
}

async function sendWebhook(details) {
  let date = new Date();
  let product = details[0];
  let storeName = details[1];
  let storeStock = details[2];
  let region = details[3];
  let storeAddr = details[4];
  const embed = new MessageBuilder()
  .setColor("#d2738a")
  .setTitle(product[1])
  .setURL(product[2])
  .setThumbnail(product[3])
  .addField("Store", "" + storeName + "", true)
  .addField("Stock", "" + storeStock + "", true)
  .addField("Region", "" + region + "", true)
  .addField("Address", "" + storeAddr + "", false)
  hookObject[region].setUsername("Target In-Store Monitor");
  hookObject[region].send(embed);  
}

/*
   -----------------------
   -----------------------
*/

//Static Functions
async function getPrompt() {
  const choices = ['What are you hankering for?', 'Pick your poison', 'Set forth your modus operandi'];
  return choices[await getRandomInt(choices.length)];
}

async function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

function getTime(id) {
  let date = new Date();
  if(id != null) {
    return '[' + date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds() + '] | ' + id + ' > ';
  }
  return '[' + date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds() + '] | > ';
}
