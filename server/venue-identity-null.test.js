'use strict';
const test=require('node:test'),assert=require('node:assert');
const {identity,features}=require('./venue-identity');
test('identity tolerates null coin metadata (research export must not crash)',()=>{
 assert.deepEqual(identity(null,'after',Date.now(),null),{launchpad:null,dex:null,venue:null,venueObservedAt:null});
 assert.deepEqual(features(null,'after',Date.now()),{launchpad:null,dex:null});
});
