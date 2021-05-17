module.exports = {

  stages: {
    "internal.api.dev.flora.insure": {
      "VPCLINK": "5cl4aw",
      "VPCNLB": "api.dev.flora.insure"
    },
    "internal.api.tst.flora.insure": {
      "VPCLINK": "biu50r",
      "VPCNLB": "api.tst.flora.insure"
    }
  },

  clientCertificates: {
    "internal.api.dev.flora.insure": "5c6i0j",
    "internal.api.tst.flora.insure": "92fyrw"
  },

  webAcl: {
    "internal.api.dev.flora.insure": "flora-dev-api",
    "internal.api.tst.flora.insure": "flora-tst-api"
  }

};
