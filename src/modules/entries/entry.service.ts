import entryModel from './entry.model';
import EntryCatgegoryBundle from './entryCatgegoryBundle.interface';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import User from '../users/user.interface';
import userModel from '../users/user.model';
import categoryModel from './category.model';
import { typeMap } from './built-in_category.map';
import moment from 'moment';
import { Service } from 'typedi';

type exclusiveConditin = {
    $ne: any[];
};

type sortColumn = {
    date?: number;
    amount?: number;
};

type googleToken = {
    access_token: string;
    refresh_token: string;
};

@Service()
class EntryService {
    public async fetchEntries(
        user: User,
        timeStart: string,
        timeEnd: string,
        categoriesExclude: string[],
        entriesSortByDate: boolean
    ): Promise<EntryCatgegoryBundle[]> {
        let andCondition: exclusiveConditin[] = [];
        andCondition = andCondition.concat(
            categoriesExclude.map((x) => {
                return { $ne: ['$category', +x] };
            })
        );

        const sortByWhichColumn = entriesSortByDate ? 'date' : 'amount';

        const sort: sortColumn = { [sortByWhichColumn]: -1 };

        return entryModel.aggregate([
            {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ['$user', user._id] },
                            { $gte: ['$date', timeStart] },
                            { $lte: ['$date', timeEnd] },
                            ...andCondition
                        ]
                    }
                }
            },
            { $sort: sort },
            {
                $group: {
                    _id: {
                        category: '$category'
                    },
                    entries: {
                        $push: {
                            amount: '$amount',
                            date: '$date',
                            descr: '$descr'
                        }
                    },
                    sum: {
                        $sum: '$amount'
                    }
                }
            },
            { $sort: { sum: -1 } },
            {
                $lookup: {
                    from: 'categories',
                    localField: '_id.category',
                    foreignField: '_id',
                    as: 'category'
                }
            }
        ]);
    }

    public async syncEntry(token: googleToken, userId: number): Promise<any> {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUrl = `${process.env.VUE_APP_BACKEND_API_BASE_URL}/entries/sync/callback`;

        const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);

        let res;
        try {
            oAuth2Client.setCredentials(token);
            res = await this.fetchAndReadEntries(oAuth2Client);
        } catch (err) {
            const url = oAuth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: ['https://www.googleapis.com/auth/drive.readonly'],
                prompt: 'consent'
            });

            return {
                status: 301,
                message: url
            };
        }

        // get the last _id
        let { _id } = await entryModel
            .find({}, { _id: 1 })
            .sort({ _id: -1 })
            .limit(1)
            .then((res) => {
                return res[0] || { _id: 0 };
            });

        let { _id: catId } = await categoryModel
            .find({}, { _id: 1 })
            .sort({ _id: -1 })
            .limit(1)
            .then((res) => {
                return res[0] || { _id: 0 };
            });

        const session = await entryModel.startSession();
        await session.withTransaction(async () => {
            await entryModel.deleteMany({ user: userId }, { session });
            await categoryModel.deleteMany({ user: userId }, { session });
            const idMap = [];

            const categories = res.categories.map((v) => {
                idMap[v._id] = ++catId;
                v._id = catId;
                const builtInName = typeMap[v.name];
                if (builtInName) v.name = builtInName;
                v.user = userId;
                delete v.default_name;
                delete v.icon;
                delete v.behavior;
                v.color =
                    '#' +
                    Math.floor(Math.random() * 16777215)
                        .toString(16)
                        .padStart(6, '0');
                return v;
            });

            await categoryModel.insertMany(categories, { session });

            const entries = res.entries.map((v) => {
                v._id = ++_id;
                v.amount = parseInt(v.amount);
                v.category = idMap[parseInt(v.category_id)];
                v.user = userId;
                delete v.category_id;
                delete v.routine_id;
                return v;
            });
            await entryModel.insertMany(entries, { session });
        });

        await session.endSession();

        const message = `${res.entries.length} items have been inserted/updated`;

        return {
            status: 200,
            message
        };
    }

    private async fetchAndReadEntries(oAuth2Client: OAuth2Client): Promise<any> {
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });
        // Find the newest ahorro backup file
        const fileId: string = await drive.files
            .list({
                orderBy: 'createdTime desc',
                pageSize: 1,
                q: "name contains 'ahorro'"
            })
            .then((res) => res.data.files[0].id)
            .catch((err) => {
                throw err;
            });

        return await drive.files
            .get(
                {
                    fileId,
                    alt: 'media'
                },
                { responseType: 'stream' }
            )
            .then(async (res) => {
                const chucks: Buffer[] = [];
                return new Promise((resolve, reject) => {
                    res.data.on('data', (chunk) => chucks.push(Buffer.from(chunk)));
                    res.data.on('error', (err) => reject(err));
                    res.data.on('end', () =>
                        resolve(JSON.parse(Buffer.concat(chucks).toString('utf8')))
                    );
                });
            })
            .then((res: any) => ({
                entries: res.tables.find((v) => v.tableName === 'expense').items,
                categories: res.tables.find((v) => v.tableName === 'category').items
            }));
    }

    public async googleCallback(code: string, user: User): Promise<any> {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const redirectUrl = `${process.env.VUE_APP_BACKEND_API_BASE_URL}/entries/sync/callback`;

        const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);
        const token = await oAuth2Client.getToken(code);

        await userModel.updateOne(
            { _id: user._id },
            {
                google_refresh_token: token.tokens.refresh_token,
                google_access_token: token.tokens.access_token
            }
        );

        return token.tokens;
    }

    public async getMonthlySum(year: string): Promise<any> {
        const timeStart = moment(`${year}-01-01`).toISOString();
        const timeEnd = moment(`${year}-12-31 23:59:59`).toISOString();

        let result = await entryModel.aggregate([
            { $match: { date: { $gte: timeStart, $lte: timeEnd } } },
            {
                $group: {
                    _id: { $substr: ['$date', 0, 7] },
                    sum: { $sum: '$amount' }
                }
            },
            { $sort: { _id: 1 } }
        ]);

        // Insert the month without entries with sum = 0
        for (let i = 1; i <= 12; i++) {
            let monthStr = i.toString();
            if (i < 10) monthStr = '0' + i.toString();
            const dateStr = `${year}-${monthStr}`;
            const isExist = result.findIndex((v) => {
                if (v._id == dateStr) return true;
            });

            if (isExist === -1) {
                result.push({ _id: dateStr, sum: 0 });
            }
        }

        // Sort the result by month
        result.sort((a, b) => {
            if (a._id > b._id) return 1;
            else return -1;
        });

        // Turn the _id into month and readable format
        result = result.map((v) => {
            return {
                month: moment(v._id).format('MMMM'),
                sum: v.sum
            };
        });

        return result;
    }
}

export default EntryService;
