'use strict';

// Usage aggregator service.

const _ = require('underscore');
const request = require('cf-abacus-request');
const cluster = require('cf-abacus-cluster');
const config = require('cf-abacus-service-config');

const map = _.map;
const omit = _.omit;
const extend = _.extend;

// Configure test db URL prefix
process.env.COUCHDB = process.env.COUCHDB || 'test';

// Mock the cluster module
require.cache[require.resolve('cf-abacus-cluster')].exports = extend((app) => app, cluster, { single: spy() });

// Mock the service config module
require.cache[require.resolve('cf-abacus-service-config')].exports = extend((sid) => ({ id: '1234', aggregations: [{ id: 'calls', aggregate: (a, qty) => a ? a + qty : qty }]}), config);

// Mock the batch module
require('cf-abacus-batch');
require.cache[require.resolve('cf-abacus-batch')].exports = spy((fn) => fn);

const aggregator = require('..');

describe('cf-abacus-usage-aggregator', () => {
    it('constructs aggregated usage for an organization', () => {
        // Define the sequence of aggregated usage we're expecting for an org
        const aggregated = [{
            organization_guid: 'org_456',
            services: [
                { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 12 }]}
            ],
            spaces: [
                { id: 'space_567', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 12 }]} ],
                    consumers: [ { id: '123', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 12 }]} ] } ]}
            ]
        }, {
            organization_guid: 'org_456',
            services: [
                { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 22 }]}
            ],
            spaces: [
                { id: 'space_567', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 22 }]} ],
                    consumers: [ { id: '123', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 22 }]} ] } ]}
            ]
        }];

        // Construct the aggregated usage using the org object defined by the
        // aggregator module
        const agg = [];
        agg[0] = aggregator.newOrg('org_456');
        agg[0].service('1234').resource('calls').quantity = 12;
        agg[0].space('space_567').service('1234').resource('calls').quantity = 12;
        agg[0].space('space_567').consumer('123').service('1234').resource('calls').quantity = 12;
        // Serialize to JSON to simulate db storage and retrieval, and expect
        // the object tree to match the above aggregated usage for the org
        expect(JSON.parse(JSON.stringify(agg[0]))).to.deep.equal(aggregated[0]);

        // Serialize to JSON to simulate db storage and retrieval, then revive
        // the org object behavior
        agg[1] = aggregator.reviveOrg(JSON.parse(JSON.stringify(agg[0])));
        agg[1].service('1234').resource('calls').quantity = 22;
        agg[1].space('space_567').service('1234').resource('calls').quantity = 22;
        agg[1].space('space_567').consumer('123').service('1234').resource('calls').quantity = 22;
        // Serialize to JSON to simulate db storage and retrieval, and expect
        // the object tree to match the above aggregated usage for the org
        expect(JSON.parse(JSON.stringify(agg[1]))).to.deep.equal(aggregated[1]);
    });

    it('aggregates usage for an organization', function(done) {
        this.timeout(60000);

        // Create a test aggregator app
        const app = aggregator();

        // Listen on an ephemeral port
        const server = app.listen(0);

        // Define a sequence of accumulated usage for a service instance
        const usage = [
            { id: '222', batch_id: '555', service_id: '1234', service_instance_id: '123', start: 1420243200000, end: 1420245000000, plan_id: 'plan_123', region: 'us',
                organization_guid: 'org_456', space_guid: 'space_567', consumer: { type: 'external', value: '123' }, accumulated_usage: [{ unit: 'calls', quantity: 12, delta: 12 }]},
            { id: '223', batch_id: '555', service_id: '1234', service_instance_id: '123', start: 1420245000000, end: 1420247000000, plan_id: 'plan_123', region: 'us',
                organization_guid: 'org_456', space_guid: 'space_567', consumer: { type: 'external', value: '123' }, accumulated_usage: [{ unit: 'calls', quantity: 22, delta: 10 }]}];

        // Post accumulated usage to the aggregator
        let locations = {};
        const post = (done) => {
            let cbs = 0;
            const cb = () => { if(++cbs === usage.length) done(); };

            // Post each usage doc
            map(usage, (u) => request.post('http://localhost::p/v1/metering/accumulated/usage', { p: server.address().port, body: u }, (err, val) => {
                expect(err).to.equal(undefined);

                // Expect a 201 with the location of the aggregated usage
                expect(val.statusCode).to.equal(201);
                expect(val.headers.location).to.not.equal(undefined);

                // Record the location returned for each usage doc
                locations[u.id] = val.headers.location;
                cb();
            }));
        };

        // Define the sequence of aggregated usage we're expecting for an org
        const aggregated = [{
            organization_guid: 'org_456', usage_id: '222',
            start: 1420502400000, end: 1420588799999,
            services: [
                { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 12 }]}
            ],
            spaces: [
                { id: 'space_567', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 12 }]} ],
                    consumers: [ { id: '123', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 12 }]} ] } ]}
            ]
        }, {
            organization_guid: 'org_456', usage_id: '223',
            start: 1420502400000, end: 1420588799999,
            services: [
                { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 22 }]}
            ],
            spaces: [
                { id: 'space_567', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 22 }]} ],
                    consumers: [ { id: '123', services: [ { id: '1234', aggregated_usage: [{ unit: 'calls', quantity: 22 }]} ] } ]}
            ]
        }];

        // Get the aggregated usage history
        const get = (done) => {
            let cbs = 0;
            const cb = () => { if(++cbs === usage.length) done(); };

            // Get each version of the aggregated usage
            map(usage, (u) => request.get(locations[u.id], {}, (err, val) => {
                expect(err).to.equal(undefined);
                expect(val.statusCode).to.equal(200);

                // Expect our test aggregated values
                if(val.body.usage_id === '222') expect(omit(val.body, 'id')).to.deep.equal(aggregated[0]);
                if(val.body.usage_id === '223') expect(omit(val.body, 'id')).to.deep.equal(aggregated[1]);

                cb();
            }));
        };

        // Run the above steps
        post(() => get(done));
    });
});

